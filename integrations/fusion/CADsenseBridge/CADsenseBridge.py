"""CADsense Bridge: builds plates sent from CADsense's CAM panel as Fusion documents.

CADsense posts a plate (outline, holes, cutouts, pockets, all in inches) with its router settings to
http://127.0.0.1:27190/plates. The add-in rebuilds the plate as a solid, makes a milling setup with
the plan's operations (pockets, bores, inside contours, then the outside profile with tabs),
generates the toolpaths, and answers with Fusion's machining time and any operation that failed.
Posting stays in Fusion, with the team's own post-processor.

Fusion's API only runs on its main thread, so the HTTP thread hands each job over through a custom
event and waits for the answer. Jobs run one at a time.
"""

import json
import math
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import adsk.cam
import adsk.core
import adsk.fusion

PORT = 27190
EVENT_ID = "cadsense-bridge-job"
ATTRIBUTE_GROUP = "cadsense"
CM = 2.54  # Fusion's API works in centimetres; CADsense sends inches.
SPINDLE_RPM = 18000
STOCK_MARGIN = 0.25  # inches of sheet left around the plate on each side
GENERATE_TIMEOUT = 300  # seconds

app = adsk.core.Application.get()
handlers = []
server = None
jobs = {}
job_lock = threading.Lock()


class JobError(Exception):
    """A failure to show the user as it is, without a traceback."""


# ---------------------------------------------------------------------------------------------
# HTTP: runs on its own thread and never touches the Fusion API.


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    # Any page may call the bridge: it only builds documents, and only on this computer. Chrome
    # asks before a page reaches a local address, which is what Allow-Private-Network answers.
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "Not found."})

    def do_POST(self):
        if self.path != "/plates":
            self._send(404, {"error": "Not found."})
            return
        try:
            job = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        except ValueError:
            self._send(400, {"error": "The plate was not valid JSON."})
            return
        # One job at a time: Fusion builds one document before starting the next.
        with job_lock:
            key = str(id(job))
            entry = {"job": job, "done": threading.Event(), "status": 500, "body": None}
            jobs[key] = entry
            app.fireCustomEvent(EVENT_ID, key)
            finished = entry["done"].wait(GENERATE_TIMEOUT + 60)
            jobs.pop(key, None)
        if not finished:
            self._send(504, {"error": "Fusion took too long to build the plate."})
        else:
            self._send(entry["status"], entry["body"])

    def log_message(self, *args):
        pass


class JobHandler(adsk.core.CustomEventHandler):
    """Runs a job on Fusion's main thread and hands the answer back to the HTTP thread."""

    def notify(self, args):
        entry = jobs.get(args.additionalInfo)
        if not entry:
            return
        try:
            entry["body"] = build_plate(entry["job"])
            entry["status"] = 200
        except JobError as error:
            entry["body"] = {"error": str(error)}
            entry["status"] = 422
        except Exception:
            # The last line names the failure; the whole trace goes to Fusion's text commands.
            trace = traceback.format_exc()
            print(trace)
            entry["body"] = {"error": "The bridge failed: " + trace.strip().splitlines()[-1]}
            entry["status"] = 500
        finally:
            entry["done"].set()


def run(context):
    global server
    try:
        event = app.registerCustomEvent(EVENT_ID)
        handler = JobHandler()
        event.add(handler)
        handlers.append(handler)
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    except Exception:
        app.userInterface.messageBox("CADsense Bridge could not start:\n" + traceback.format_exc())


def stop(context):
    if server:
        server.shutdown()
        server.server_close()
    app.unregisterCustomEvent(EVENT_ID)
    handlers.clear()


# ---------------------------------------------------------------------------------------------
# Fusion work: runs on the main thread.


def build_plate(job):
    """Builds one plate and its setup. The job is CADsense's PlateGeometry plus settings."""
    plate = job["plate"]
    settings = job["settings"]
    doc, replaced = open_document(job["key"])
    design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
    design.fusionUnitsManager.distanceDisplayUnits = adsk.fusion.DistanceUnits.InchDistanceUnits
    if replaced:
        clear_document(doc, design)

    body, built = build_body(design.rootComponent, plate)

    app.userInterface.workspaces.itemById("CAMEnvironment").activate()
    cam = adsk.cam.CAM.cast(doc.products.itemByProductType("CAMProductType"))
    setup = create_setup(cam, body, job["name"])
    tool = create_tool(settings)
    results = []
    for name, make in plan_operations(job, built, body):
        try:
            op = make(setup, tool)
            apply_feeds(op, settings)
            results.append((name, op, None))
        except Exception as error:
            results.append((name, None, str(error) or type(error).__name__))

    future = cam.generateToolpath(setup)
    started = time.time()
    while not future.isGenerationCompleted:
        if time.time() - started > GENERATE_TIMEOUT:
            raise JobError("Fusion is still generating toolpaths; check the setup in Fusion.")
        adsk.doEvents()
        time.sleep(0.05)

    operations = []
    for name, op, failure in results:
        if failure:
            operations.append({"name": name, "state": "error", "message": failure})
        elif op.hasError:
            operations.append(
                {"name": name, "state": "error", "message": "Fusion could not generate it"}
            )
        elif op.hasWarning:
            operations.append({"name": name, "state": "warning", "message": "Fusion warned"})
        else:
            operations.append({"name": name, "state": "ok"})
    # Rapids at 400 in/min and no tool changes: one tool cuts the whole plate.
    seconds = cam.getMachiningTime(setup, 1.0, 400 * CM, 0).machiningTime
    return {"replaced": replaced, "minutes": seconds / 60, "operations": operations}


def open_document(key):
    """The open document that holds this plate, activated, or a new one tagged with the key."""
    for i in range(app.documents.count):
        doc = app.documents.item(i)
        attribute = doc.attributes.itemByName(ATTRIBUTE_GROUP, "plate")
        if attribute and attribute.value == key:
            doc.activate()
            return doc, True
    doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    doc.attributes.add(ATTRIBUTE_GROUP, "plate", key)
    return doc, False


def clear_document(doc, design):
    """Removes the last build: its setups first, since they point at the body."""
    cam = adsk.cam.CAM.cast(doc.products.itemByProductType("CAMProductType"))
    if cam:
        for setup in [cam.setups.item(i) for i in range(cam.setups.count)]:
            setup.deleteMe()
    app.userInterface.workspaces.itemById("FusionSolidEnvironment").activate()
    design.timeline.moveToBeginning()
    design.timeline.deleteAllAfterMarker()


def point(x, y):
    return adsk.core.Point3D.create(x * CM, y * CM, 0)


def value(inches):
    return adsk.core.ValueInput.createByReal(inches * CM)


def draw_polygon(sketch, polygon):
    """A closed chain of lines through the points, sharing endpoints so it makes a profile."""
    lines = sketch.sketchCurves.sketchLines
    points = [p for i, p in enumerate(polygon) if i == 0 or p != polygon[i - 1]]
    first = lines.addByTwoPoints(point(*points[0]), point(*points[1]))
    last = first
    for p in points[2:]:
        last = lines.addByTwoPoints(last.endSketchPoint, point(*p))
    lines.addByTwoPoints(last.endSketchPoint, first.startSketchPoint)


def new_sketch(component, draw):
    sketch = component.sketches.add(component.xYConstructionPlane)
    sketch.isComputeDeferred = True
    draw(sketch)
    sketch.isComputeDeferred = False
    return sketch


def largest_profile(sketch, loops=None):
    """The sketch's largest profile, or its largest with this many loops (a pocket and islands)."""
    profiles = [sketch.profiles.item(i) for i in range(sketch.profiles.count)]
    if loops is not None:
        profiles = [p for p in profiles if p.profileLoops.count == loops] or profiles
    if not profiles:
        raise JobError("A plate outline did not close in Fusion.")
    return max(profiles, key=lambda p: p.areaProperties().area)


def cut(component, body, profile, top, depth):
    """Cuts a profile sketched at z = 0 from `top` down by `depth` inches."""
    extrudes = component.features.extrudeFeatures
    cut_input = extrudes.createInput(profile, adsk.fusion.FeatureOperations.CutFeatureOperation)
    cut_input.startExtent = adsk.fusion.OffsetStartDefinition.create(value(top))
    cut_input.setOneSideExtent(
        adsk.fusion.DistanceExtentDefinition.create(value(depth)),
        adsk.fusion.ExtentDirections.NegativeExtentDirection,
    )
    cut_input.participantBodies = [body]
    return extrudes.add(cut_input)


def build_body(component, plate):
    """The plate solid. Returns it with each feature's extrude, for picking faces later."""
    thickness = plate["thickness"]
    outline = new_sketch(component, lambda s: draw_polygon(s, plate["outline"]))
    body = (
        component.features.extrudeFeatures.addSimple(
            largest_profile(outline),
            value(thickness),
            adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
        )
        .bodies.item(0)
    )
    body.name = "Plate"
    built = []
    # Pockets from the top down, so a pocket inside another is cut from the outer one's floor.
    pockets = sorted(
        (f for f in plate["features"] if f["kind"] == "pocket"), key=lambda f: -f["top"]
    )
    for pocket in pockets:

        def draw(sketch, pocket=pocket):
            draw_polygon(sketch, pocket["polygon"])
            for island in pocket["islands"]:
                draw_polygon(sketch, island)

        sketch = new_sketch(component, draw)
        profile = largest_profile(sketch, loops=1 + len(pocket["islands"]))
        depth = pocket["top"] - pocket["floor"]
        built.append((pocket, cut(component, body, profile, pocket["top"], depth)))
    # Holes and cutouts go all the way through; above a pocket floor there is nothing left to cut.
    for feature in plate["features"]:
        if feature["kind"] == "hole":
            draw = lambda s, f=feature: s.sketchCurves.sketchCircles.addByCenterRadius(
                point(*f["center"]), f["diameter"] / 2 * CM
            )
        elif feature["kind"] == "cutout":
            draw = lambda s, f=feature: draw_polygon(s, f["polygon"])
        else:
            continue
        sketch = new_sketch(component, draw)
        built.append((feature, cut(component, body, largest_profile(sketch), thickness, thickness)))
    return body, built


def create_setup(cam, body, name):
    """A milling setup on the plate in a sheet with a margin, zeroed at the stock's top corner."""
    setup_input = cam.setups.createInput(adsk.cam.OperationTypes.MillingOperation)
    setup_input.models = [body]
    setup_input.stockMode = adsk.cam.SetupStockModes.RelativeBoxStock
    parameters = setup_input.parameters
    for parameter, expression in (
        ("job_stockOffsetMode", "'simple'"),
        ("job_stockOffsetSides", f"{STOCK_MARGIN} in"),
        ("job_stockOffsetTop", "0 in"),
        ("job_stockOffsetBottom", "0 in"),
        ("wcs_origin_boxPoint", "'top 1'"),
    ):
        # Stock and origin are conveniences: Fusion's defaults still make a working setup.
        try:
            parameters.itemByName(parameter).expression = expression
        except Exception:
            pass
    setup = cam.setups.add(setup_input)
    setup.name = name
    return setup


def create_tool(settings):
    """A two-flute flat end mill of the plan's diameter, with its feeds as the default preset."""
    diameter = settings["tool"]
    return adsk.cam.Tool.createFromJson(
        json.dumps(
            {
                "type": "flat end mill",
                "unit": "inches",
                "description": f"CADsense {diameter:g} in flat",
                "BMC": "carbide",
                "geometry": {
                    "DC": diameter,
                    "SFDM": diameter,
                    "NOF": 2,
                    "LCF": max(0.5, diameter * 4),
                    "LB": 1.0,
                    "OAL": 2.0,
                    "shoulder-length": max(0.55, diameter * 4.4),
                    "CSP": False,
                    "HAND": True,
                    "RE": 0,
                    "TA": 0,
                },
                "post-process": {"number": 1, "length-offset": 1, "diameter-offset": 1},
                "start-values": {
                    "presets": [
                        {
                            "name": "CADsense",
                            "n": SPINDLE_RPM,
                            "v_f": settings["feed"],
                            "v_f_plunge": settings["plunge"],
                            "v_f_ramp": settings["plunge"],
                            "tool-coolant": "disabled",
                        }
                    ]
                },
            }
        )
    )


def apply_feeds(op, settings):
    for parameter, expression in (
        ("tool_spindleSpeed", f"{SPINDLE_RPM} rpm"),
        ("tool_feedCutting", f"{settings['feed']} in/min"),
        ("tool_feedPlunge", f"{settings['plunge']} in/min"),
        ("tool_feedRamp", f"{settings['plunge']} in/min"),
    ):
        item = op.parameters.itemByName(parameter)
        if item:
            item.expression = expression


def set_expressions(op, pairs):
    """Sets operation parameters by name, failing with the name Fusion did not know."""
    for parameter, expression in pairs:
        item = op.parameters.itemByName(parameter)
        if not item:
            raise JobError(f"Fusion has no '{parameter}' parameter")
        item.expression = expression


def add_operation(setup, tool, strategy, name):
    op_input = setup.operations.createInput(strategy)
    op_input.tool = tool
    op = setup.operations.add(op_input)
    op.name = name
    return op


def plan_operations(job, built, body):
    """The plan's operations in cutting order, as (name, make(setup, tool)) pairs.

    Each operation is made on its own so one Fusion rejects does not lose the others.
    """
    settings = job["settings"]
    tool_diameter = settings["tool"]
    stepdown = f"{settings['stepdown']} in"
    breakthrough = f"{-job['breakthrough']} in"
    operations = []

    pockets = [(f, ext) for f, ext in built if f["kind"] == "pocket"]
    for i, (pocket, extrude) in enumerate(pockets):

        def make_pocket(setup, tool, extrude=extrude, name=f"Pocket {i + 1}"):
            op = add_operation(setup, tool, "pocket2d", name)
            set_expressions(op, (("doMultipleDepths", "true"), ("maximumStepdown", stepdown)))
            pockets_value = op.parameters.itemByName("pockets").value
            selections = pockets_value.getCurveSelections()
            selection = selections.createNewPocketSelection()
            selection.isSelectingSamePlaneFaces = False
            floors = extrude.endFaces
            selection.inputGeometry = [floors.item(j) for j in range(floors.count)]
            pockets_value.applyCurveSelections(selections)
            return op

        operations.append((f"Pocket {i + 1}", make_pocket))

    # Bores group holes of one size, like the plan; holes the tool can't mill are drilled by hand.
    bores = {}
    for feature, extrude in built:
        if feature["kind"] == "hole" and feature["diameter"] >= tool_diameter * 1.1:
            faces = [extrude.sideFaces.item(j) for j in range(extrude.sideFaces.count)]
            bores.setdefault(round(feature["diameter"], 3), []).extend(faces)
    for diameter, faces in sorted(bores.items()):
        name = f"Bore Ø{diameter:.3f}".replace("Ø0.", "Ø.")

        def make_bore(setup, tool, faces=faces, name=name):
            op = add_operation(setup, tool, "bore", name)
            set_expressions(op, (("pitch", stepdown), ("bottomHeight_offset", breakthrough)))
            circular = op.parameters.itemByName("circularFaces")
            if not circular:
                raise JobError("Fusion has no 'circularFaces' parameter; pick the holes by hand")
            circular.value.value = faces
            return op

        operations.append((name, make_bore))

    cutouts = [(f, ext) for f, ext in built if f["kind"] == "cutout"]
    for i, (cutout, extrude) in enumerate(cutouts):
        name = f"Contour {i + 1}" if len(cutouts) > 1 else "Contour"

        def make_contour(setup, tool, cutout=cutout, extrude=extrude, name=name):
            op = add_operation(setup, tool, "contour2d", name)
            set_expressions(
                op,
                (
                    ("doMultipleDepths", "true"),
                    ("maximumStepdown", stepdown),
                    ("bottomHeight_offset", breakthrough),
                ),
            )
            edges = bottom_loop(body, extrude)
            contours = op.parameters.itemByName("contours").value
            selections = contours.getCurveSelections()
            chain = selections.createNewChainSelection()
            chain.isOpen = False
            # The tool cuts on the right of the first edge's direction, seen from above. It
            # belongs inside the opening.
            chain.isReverted = not right_side_inside(edges[0], cutout["polygon"])
            chain.inputGeometry = edges
            contours.applyCurveSelections(selections)
            return op

        operations.append((name, make_contour))

    def make_profile(setup, tool):
        op = add_operation(setup, tool, "contour2d", "Profile")
        pairs = [
            ("doMultipleDepths", "true"),
            ("maximumStepdown", stepdown),
            ("bottomHeight_offset", breakthrough),
            ("group_tabs", "true" if settings["tabs"] > 0 else "false"),
        ]
        if settings["tabs"] > 0:
            perimeter = polygon_length(job["plate"]["outline"])
            pairs += [
                ("tabWidth", f"{job['tab']['width']} in"),
                ("tabHeight", f"{job['tab']['height']} in"),
                ("tabDistance", f"{perimeter / settings['tabs']:.4f} in"),
            ]
        set_expressions(op, pairs)
        contours = op.parameters.itemByName("contours").value
        selections = contours.getCurveSelections()
        silhouette = selections.createNewSilhouetteSelection()
        silhouette.inputGeometry = [body]
        contours.applyCurveSelections(selections)
        return op

    operations.append(("Profile", make_profile))
    return operations


def bottom_loop(body, extrude):
    """The edges, in order, where a through cut leaves the plate's bottom face."""
    walls = {extrude.sideFaces.item(i).tempId for i in range(extrude.sideFaces.count)}
    for face in body.faces:
        if face.boundingBox.maxPoint.z > 1e-4 or face.boundingBox.minPoint.z < -1e-4:
            continue
        for loop in face.loops:
            if loop.isOuter:
                continue
            edges = [coedge.edge for coedge in loop.coEdges]
            if all(any(f.tempId in walls for f in edge.faces) for edge in edges):
                return edges
    raise JobError("could not find where the cutout leaves the bottom face")


def right_side_inside(edge, polygon):
    """Whether a point just right of the edge's midpoint, seen from above, is inside the polygon."""
    start = edge.startVertex.geometry
    end = edge.endVertex.geometry
    dx, dy = end.x - start.x, end.y - start.y
    length = math.hypot(dx, dy) or 1
    step = 0.01 * CM
    x = (start.x + end.x) / 2 + dy / length * step
    y = (start.y + end.y) / 2 - dx / length * step
    return point_in_polygon(x / CM, y / CM, polygon)


def point_in_polygon(x, y, polygon):
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def polygon_length(polygon):
    return sum(
        math.dist(polygon[i], polygon[(i + 1) % len(polygon)]) for i in range(len(polygon))
    )
