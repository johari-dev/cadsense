# Offline CAD acceptance inputs

`configured-assembly.json` is a mechanically sanitized evaluated assembly response from the public Epsilon CAD linked by https://frcdesign.org/mechanism-examples/. It preserves 1,346 occurrence paths and transforms, 19 nested assembly definitions, 501 declared part references, configurations, hidden state, and suppressed placeholders. Document/revision/element/instance/part identifiers and component/configuration names are replaced consistently. Unused API fields are omitted. The original was read during the explicitly authorized manual smoke test; tests never contact Onshape.

`multipart-studio.json` is a synthetic metadata fixture for a solid, a hidden sheet, and a mesh with different appearances. It is not a downloaded Part Studio response.

These inputs verify topology and metadata, not geometric fidelity. The acceptance test assigns a minimal deterministic GLB stand-in to every required geometry key. Real geometry, GPU performance, and packaged application behavior require separate evidence; passing these tests does not establish those gates.
