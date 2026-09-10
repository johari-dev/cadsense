# Coarse 3MF import and robot validation

The importer requests coarse, meter-unit 3MF and preserves per-face colors, converting sRGB colors to linear glTF material values. ZIP64 archives are supported with the existing inflated-size and integrity limits. The browser receives bounded, independently compressed chunks of the manifest-ordered geometry bundle.

3MF does not provide Onshape part/instance IDs. Unique name and placement matches retain the authoritative assembly identities. Composite member bodies can be collected at a unique placement. Ambiguous or omitted parts use geometry identified by source IDs, reused only from the same project/root/microversion. If that geometry is unavailable, a resumable coarse glTF companion export supplies it. The importer does not arbitrarily assign repeated instances.

## Full robot, September 10, 2026

- Source: Onshape document `05760c4d8b40fba37db8fa48`, workspace `f31b499c519e8471cced93dc`, assembly `b53dde24ab8b46d679af9944`.
- Inspected microversion: `de54642171d191b245abc54f`.
- Published snapshot: `3bbcdc06-7df8-473f-bd2c-421e0006586a`.
- All 467 source geometries retained; 324 supplied by 3MF and 143 by existing identity-verified geometry. Both Kraken motor geometries retain 14 material color groups.
- Final manifest has 462 distinct asset hashes, totaling 202,050,012 bytes before HTTP compression, versus 322,976,716 bytes in the previous import. The pre-normalization conversion was 169,044,164 bytes; that is not the final download size.
- Real HTTP checks verify every asset hash and unauthorized-ticket rejection. Bounded delivery through Tailscale took approximately 3.4 seconds in the Node test client, using 49 local HTTP requests. This measurement excludes parsing/rendering and does not establish a sub-10-second CAD display.

A local headless Chrome test of the actual Tailscale preview rendered the complete scene in 6.38 and 6.16 seconds across two fresh-browser runs from thread selection (CAD panel already configured open). A screenshot confirmed the robot was visible with 1,362 component-tree entries. The connected automation browser had separate intermittent page/WebSocket/download failures, so its results are not used for this timing. Switching to another thread in the same project took 0.83 seconds with zero additional CAD HTTP requests. These are measured local-browser results, not a guarantee for other devices or networks.

## Quota accounting for this implementation run

| Work                                                    | Actual API requests | Quota-counted successful requests |
| ------------------------------------------------------- | ------------------: | --------------------------------: |
| Small Kraken compatibility export                       |                   3 |                                 3 |
| Robot attempt rejected locally before export submission |                   2 |                                 2 |
| Robot definition/export/poll/download attempt           |                   9 |                                 9 |
| Resume saved robot export and publish                   |                   1 |                                 1 |
| Total                                                   |                  15 |                                15 |

The robot-specific cost was 12 credits; total implementation validation cost was 15. Offline conversion, HTTP delivery, and browser checks do not call Onshape. This excludes the earlier nine-request detail-level experiment. Counts follow [Onshape's quota rules](https://onshape-public.github.io/docs/auth/limits/) for successful API-key calls; returned rate-limit headers describe endpoint rate windows, not an annual-credit balance.
