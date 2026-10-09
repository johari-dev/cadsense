# Drivetrain analysis

The `drivetrain` check in `cad_checks` answers the questions the review guidance asks agents to
work out from screenshots: does each gear pair sit at the right center distance, does every belt
or chain wrap a pulley or sprocket at both ends and match its length, is every shaft carried by a
bearing, and does power from each motor reach the rollers. Opus answers these by capturing dozens
of views. Smaller models skip them and write generic advice, so `CadDrivetrain.ts` computes them.

## How it reads a model

1. **Roles from names.** FRC teams build from vendor libraries whose part names carry the data:
   `40t Pocketed Steel Spur Gear (20 DP, 1/2" Hex Bore)`, `Vortex Shaft (20DP Gear - 7T)`,
   `70T 5M 9mm Wide Belt`, `92L #25 Chain`, `Roller Endcap_HTD_24_Tooth`, `MAXPlanetary 5:1 Slice`.
   `cadDrivetrainRole` reads tooth counts, diametral pitch, belt pitch, chain links, planetary
   ratios, and profile-shifted pinions (`8t, 10t Center Distance`). Fastener words lose to tooth
   counts, and `Hex Bore` means a hole, not a shaft.
2. **Axes from meshes.** `fitCadAxis` takes area-weighted triangle centroids and their principal
   directions. A rotationally symmetric part has two equal spreads, and its axis is the third.
   Parts about as long as they are wide (pulley endcaps, motors) have no clear answer, so
   `alignToCarrier` snaps them to a shaft or roller that runs through their middle.
3. **Relations.** Coaxial parts form rotating groups. Gears in different groups with parallel axes
   and faces in line are checked against `(T1 + T2) / (2 DP)`. A loop wraps the wheels inside its
   plane, and its length is checked against the two-wheel belt formula. Bearings on a group
   support it.
4. **Power.** A breadth-first search from each motor (through its planetary stack) follows meshes,
   belts, and chains. Motors that reach the same groups are reported together.

A motor controller (SPARK Flex, SPARK MAX, Talon, Victor) on a motor's axis in front of the face its shaft
comes out of sits between the motor and its mount, so the motor is not held.

**Spinning-part collisions.** `rotatingCollisions` reads the exact overlaps `mesh-interference`
found and reports a `collision` when a recognized gear, pulley, sprocket, shaft, or roller runs into
a part it should clear, such as the transfer's 40T gear cutting into its frame tube. Intended fits
are skipped: parts coaxial with the spinning part (its shaft, hub, spacer), a pin or spacer parallel
to it and wholly inside its radius (bolted to it), bearings, belts and chains, gear pairs (the mesh
check covers them), game pieces, fasteners, and overlaps inside one vendor subassembly. Geometry
cannot see mates, so a part bolted on at an angle, or a tight spline fit tessellated into a sliver,
still reads as a collision.

**Placements.** For a collision, two gears set so close they overlap, and a belt or chain with a bare
end, `cad_checks` computes where a comment marker belongs (see "Check-placed points" in
[CadComments.md](CadComments.md)): the seam of the overlap nearest its middle, or the bare end of
the loop viewed face-on.

A finding is `problem: true` only when every part involved was recognized. A trace that runs into
an unrecognized part says so and is never a problem, and the unpowered-roller finding is a problem
only when every motor was traced and no roller is reached at all: a roller left out while others
are driven may be an idler. Power paths are facts, not problems: an arm's last gear drives the arm
itself. A belt or chain wrapping a sprocket or pulley at each end gets a `loop-length` finding:
a belt that is too long or short, or a chain that is too short, is a problem; chain slack, and any
loop wrapping more than two wheels (an idler or tensioner), is a lead. `cad_checks` drafts comments
for problems but never for `loop-length`, whose fix depends on parts it cannot see.

## Limits

- Parts without vendor names (custom gears named `Part 12`) are invisible to it.
- Axes come from tessellated meshes, so center distances carry about 0.002 in of noise. Pairs up
  to 0.004 in too close or 0.006 in too far are reported as meshing.
- Belt length uses pitch radius `T * p / 2π` for both belts and chains, which is close for chain
  sprockets above about 15 teeth.
- It does not know whether a tensioner exists, so chain slack is a lead.
- A shaft carried only by a custom-named bushing or a bearing block is reported unsupported. Bushings
  with `bushing` in their name count as bearings; agents decline such a draft after inspecting it.
- It does not check mates. A motor mated in the wrong place shows up only through interference.

## Results on stored models

| Model                      | Recognized | Problems reported | Checked against                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2013 transfer, 88 parts    | 30         | 9                 | Answer key in [the review evaluation](CadReviewEvaluation.md): finds problems 1, 2 (spacing), 3 (bearings), 5, 6, 7, and 8 (SPARK Flex docked in front of the Vortex). Correctly passes both 70T belts.                                                                                                                                                                           |
| Telescoping arm, 419 parts | 113        | 9                 | Four 92L chains with about 2.2 links of slack each. All five SPARK Flex controllers sit 1.28 in in front of their Vortex, against the gearbox input plate, the same placement as the transfer's confirmed problem 8; likely one reused motor subassembly, not yet confirmed with the designer. Gear spacing, the profile-shifted pinion, and the 15:1 planetaries read correctly. |
| Elevator, 335 parts        | 91         | 4                 | Two 295T belts 4 mm long and two 60T belts 5 to 6 mm short for their centers. Not yet confirmed with the designer.                                                                                                                                                                                                                                                                |

`apps/server/scripts/cad-drivetrain-probe.ts` prints these from a stored snapshot.

## Ways this can fail

`CadDrivetrain.test.ts` covers each of these with synthetic meshes:

- A role is read from the wrong word (`Controller` as a roller, `Shaft End Screw` as a shaft, `Square Nut` hiding a pulley, `Roller Hub (1/2" Hex Bore)` as a shaft, `motor support` as a motor).
- A common FRC motor, gearbox, belt, chain, or shaft name goes unrecognized (Kraken, Falcon, NEO 550, MAXPlanetary and VersaPlanetary stages, GT2 pulleys, #35 chain, MAXSpline and ThunderHex shafts).
- A disc and a rod with similar spreads get the wrong axis, and nothing snaps it back.
- A profile-shifted pinion is checked at its tooth count instead of its center-distance count.
- Mirrored or distant gears on parallel axes are reported as a failed mesh.
- A belt that wraps two pulleys is reported bare because an end test uses the wrong extent.
- A motor with an unrecognized output, or a trace that ends at an unrecognized part, is reported as a problem.
- Two motors on one gearbox are reported twice.
- Repeated runs on one snapshot return findings in a different order.
- A motor controller docked in front of its motor, between the motor face and whatever the motor bolts to, is not reported.
- A controller docked on the back of its motor, where it belongs, is reported.
- A gear on its shaft, a shaft in its bearing or spacer, a belt on its pulley, two meshing gears, a game piece, a fastener, or two parts inside one vendor subassembly is reported as a collision.
- A pin or spacer bolted through a spinning part is reported as a collision.
- A bare-belt marker lands on the end that has a pulley, or is viewed edge-on.
- A standoff, a spline or hex adapter, or a shaft coupler is read as a shaft, so it is reported unsupported or stacked on a real shaft; a bushing is read as a shaft instead of a bearing.
- A roller left out while others are driven, such as an idler, is reported as a proven problem.
- Chain slack, or a loop around an idler or tensioner, is reported as a proven length problem.
- A loop around three wheels links only two of them, so a motor on the third reaches nothing.
- A problem's draft wording uses raw CAD names, starts lowercase, calls two gears with one tooth count "the 40T gear and the 40T gear", drops the spacing, needed spacing, ratio, or belt length the student acts on, states only one error for gears set at the wrong spacing whose faces also miss, or has no next step; or the agent's `summary` loses the exact names it uses to find parts.

Collisions on stored models: the transfer reports exactly its three (the 40T gear into the 1x1
tube, both jackshafts into the SPARK Flex). The arm reports the 16.5 in MAXSpline running into two
0.26 in plates (`WCP-0416-001` and `-003`), an overlap 0.48 mm deep that may be a tessellated spline
fit. The elevator reports a 40T gear touching a cable clamp plate (0.55 mm deep). Neither has been
confirmed with its designer.
