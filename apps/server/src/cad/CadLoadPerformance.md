# Full-robot viewer investigation — 2026-09-07

The under-10-second target was not reached with all original detail on the Tailscale preview. The user chose a real progress bar as the fallback. The shipped loader retains bounded parallel GLB downloads and negotiated gzip; the temporary bundle and alternate-port experiments were removed.

## Reproduction

Epsilon assembly: 467 geometry assets, 1,362 component-tree entries, approximately 323 MB of GLB data. Measurements used the already imported revision, with zero Onshape API requests. Reload the conversation with its CAD panel open, start a navigation-time probe, and record when the Components section appears (after complete scene publication). Resource Timing separates CAD response completion from scene readiness. No coarse/progressive scene counts as ready.

The baseline was reproducible at 29.9 and 30.3 seconds after the first performance fix; the original sequential, uncompressed loader took 58.9 seconds.

## Experiments

| Path                                                | CAD transfer |            Navigation to ready |
| --------------------------------------------------- | -----------: | -----------------------------: |
| Sequential, uncompressed GLBs                       |       323 MB |                         58.9 s |
| Sequential, gzip                                    |       152 MB |                         60.0 s |
| Six concurrent requests, 32 MiB read-ahead, gzip    |       152 MB |                    29.9–30.3 s |
| Single stream, runtime gzip                         |       152 MB |                         28.2 s |
| Prepared gzip file                                  |       152 MB | 27.6 s (9.6 s before transfer) |
| Prepared Brotli file                                |       105 MB |                         19.1 s |
| Prepared uncompressed file                          |       323 MB |                         41.3 s |
| Six prepared gzip segments, HTTP/2                  |       152 MB |                         33.1 s |
| Six prepared gzip segments, TLS-terminated HTTP/1.1 |       152 MB |                         25.6 s |

Prepared gzip transferred in 17.4 seconds, Brotli in 13.7 seconds, and uncompressed data in 36.0 seconds. Scene publication followed the final response by approximately 0.2–0.5 seconds for streamed experiments. Parallel prepared segments did not establish a per-stream throughput bottleneck. Tailscale reported a direct LAN peer connection, not relay traffic; the temporary test port was removed.

Offline reads of all assets took approximately 0.3–1.0 seconds. Gzip level 1 took 8.8 seconds of compression work; prepared Brotli quality 5 took 22.1 seconds. Byte-shuffling, meshoptimizer attribute encoding, and per-accessor encoding did not produce a sufficiently small transfer to justify a new codec. Exact whole-binary deduplication reduced 322 MB to 242 MB before compression; buffer-view deduplication reached 241 MB, also insufficient by itself.

## PoC comparison

The older checkout at `D:/Projects/cadsense` uses a single compressed 3MF, a worker parser, and shared typed geometry. Its `onshape3mfTranslationRequestBody` explicitly requests `resolution: "coarse"`. It is therefore not an equivalent all-original-detail benchmark. The user explicitly rejected showing reduced review detail before refinement.

## Shipped fallback and color correction

The loading UI now reports decoded bytes against the deduplicated manifest asset total. Compressed HTTP Content-Length is not used as the denominator. Before a manifest is available it says “Preparing CAD…”; after download completion it says “Preparing geometry…” until the original scene is published atomically. Updates are throttled, reset for new loads, and ignored after cancellation.

The washed-out Kraken inside Epsilon retains the same 14 material color factors as the standalone Kraken. All 467 Epsilon geometry parts lack appearance metadata; the standalone motor has it. That difference prevented display-RGB-to-linear correction in the bulk model. A strict Onshape numeric material-name signature plus matching factors now supplies the missing evidence. Textured, unrelated, and already-linear materials remain unchanged. The regression reproduces gray `#898989` versus the intended `#404040`; offline replay of the robot assets restores the Kraken palette, including `#33ff33` and `#0072ce`.
