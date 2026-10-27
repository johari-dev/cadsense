# Drive options

`cad_drive_options` answers "what gears, belts, or chain get me this ratio?" for a model that has
none yet. A student asks for a reduction, an output speed, or a roller surface speed. The tool searches
stock FRC parts and returns ranked options with SKUs, the center distance to model for each stage,
and a [ReCalc](https://www.reca.lc) link that opens the same stage there. When the student names the
motor and the roller in their CAD, the tool measures the distance between their axes and keeps only
drives that fit it.

## How it works

1. **Target.** A reduction is used as given. An output speed is the motor's free speed divided by
   the target, and a surface speed first becomes a roller speed from the roller's diameter. Free
   speeds are ReCalc's. The motor comes from the input or from the driver part's name (`Kraken X44`,
   `NEO 550`). Loaded speed is lower than free speed, and the result says so.
2. **Catalog.** `driveCatalog.json` holds the stock gears, pulleys, belts, and sprockets from
   ReCalc's vendor data (MIT), written by `apps/server/scripts/sync-drive-catalog.ts` at a pinned
   commit. Gears under 10 teeth are left out: those pinions are usually profile shifted, and the
   catalog does not say their center distance.
3. **Axes.** With `driverOccurrenceId` and `drivenOccurrenceId`, both parts' axes come from
   `fitCadAxis`, snapped onto a shaft through them the same way `cad_checks` does it. The axes must
   be parallel. The center is the distance between the two lines. The driven part's diameter feeds
   a surface-speed target.
4. **Stages.** One stage is a pair of wheels in one family. Two stages multiply. Every stage reduces
   for a reduction above 1 and speeds up below 1, and no stage goes past 7:1.
5. **Fit.** With a fixed center, a single stage fits only when `cad_checks` would pass it once it is
   modeled: gears within the same spacing window the gear-mesh check uses, and a belt or chain whose
   length is within the loop-length check's limit of what the center needs. Both use the
   check's own formula, so a suggestion never comes back as a drivetrain problem. Two stages put a
   jackshaft between the axes. Each stage gets its own center, a stock gear spacing or a stock belt
   or chain at its exact center. The two centers must reach from one axis to the other, and the
   tool returns the two places the jackshaft axis can go.
6. **Belts and chains.** A belt must wrap at least 6 teeth of its small pulley, a chain at least
   120 degrees of its small sprocket, and the wheels must clear each other by 1/8 in. With no fixed
   center a belt or chain stage has no center and no loop, since any stock length works. Gears
   always get one: the exact center plus the usual 0.003 in.
7. **Ranking.** Options that fit come first, then fewer stages, then smaller ratio error in 0.5%
   steps, then the smallest largest wheel. At most two options share a family combination, so a
   page is not all 20 DP gears. Single stages that miss a fixed center by under 0.5 in come last,
   with how far they miss, for a student who can still move a shaft.

## Limits

- It does not check wheels against other parts. After modeling a suggestion, run `cad_checks`.
- The jackshaft position is one of two points on a circle intersection; it does not know where the
  frame is.
- Belt and chain length use the loop-length check's pitch-radius formula, which is close for chain
  sprockets above about 15 teeth.
- Bores are listed, not chosen: `driverBore` filters the first wheel only.
- Free speed, not loaded speed.

## Ways this can fail

`CadDriveOptions.test.ts` covers each of these:

- A stage's reduction is upside down, so a 3:1 reduction comes back as a 3:1 speed-up.
- An option outside the tolerance is returned, or an exact single-stage option inside it is missed.
- A two-stage product is wrong, or a two-stage option ranks above a single stage that hits the target.
- A belt or chain chosen for a fixed center, modeled as suggested, is reported by `cad_checks` as
  the wrong length; or a gear pair is reported too close or too far.
- A belt wraps fewer than 6 teeth of its small pulley, or two wheels overlap.
- A belt of one profile or pitch is paired with pulleys of another, such as an HTD belt on GT2 pulleys.
- A wheel or belt is offered in a size the catalog does not sell, or a gear under 10 teeth is offered.
- `driverBore` is ignored, so the first wheel does not come in the requested bore.
- Without a fixed center, a belt or chain is given an invented center, or gears get none.
- With two stages, the jackshaft points are not each stage's center from their axes, do not sit in
  the plane across the axes, or are offered when the two centers cannot reach between the axes.
- Axes that are not parallel are measured anyway.
- An unknown occurrence, or one that is not a part, is accepted.
- A motor is misread from its name (`NEO 550` as a NEO, `Kraken X44` as an X60), or a speed target
  with no motor is answered with a guessed one.
- A surface speed treats the roller's radius as its diameter.
- The same input returns options in a different order.
- A result page is too large to come back inline.
- A stale `expectedRevision` is accepted.
- A ReCalc link encodes the wrong teeth, pitch, or units.
