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

## Parallel investigations

Three independent subagents investigated representation, server verification, and client CPU/memory; the parent investigated transport. All used the same cached full-detail geometry. No Onshape requests or production changes were made in this round. The original 32 MiB download window and progress UI remain in place.

### Exact deduplication and compression

The new pack stores each original GLB prefix and refers to a dictionary of identical BIN chunks. Hash matches are confirmed by byte equality. The 467 GLBs contain 445 distinct BIN chunks; explicit sharing reduces the uncompressed pack to 243,482,998 bytes, including reconstruction framing. Every candidate below reconstructed every original GLB byte-for-byte.

| Prepared pack                           | Transfer | Encoding | Decode + reconstruction (Node) |
| --------------------------------------- | -------: | -------: | -----------------------------: |
| Exact BIN dedup + Zstd 19, 8 MiB window | 66.98 MB | 108.80 s |                         1.73 s |
| Exact BIN dedup + Brotli 5              | 73.06 MB |  16.85 s |                         2.17 s |
| Exact BIN dedup + Zstd 9, 8 MiB window  | 80.66 MB |   5.14 s |                         1.17 s |
| Exact BIN dedup + Zstd 15, 8 MiB window | 78.81 MB |  43.12 s |                         1.21 s |

Dedup preparation adds approximately 0.29 seconds. Level 15 is a poor tradeoff against level 9. Accessor-aware XOR/delta predictors produced 104–106 MB and added roughly 10 seconds of inverse/verification work, so they were rejected. A 512 MiB Zstd history also compressed well but exceeds the native HTTP decoder profile; the deduplicated Zstd candidates above use the bounded 8 MiB profile.

The 67 MB result is 56% smaller than the currently shipped 152 MB gzip transfer. It is the best size result, not a verified browser load time. Preparation must happen before opening CAD. Brotli 5 is the less expensive candidate to test first if adding almost two minutes to import/cache preparation is unacceptable.

The naive offline harness holds originals, packed bytes, decoded bytes, and reconstructed GLBs simultaneously, exceeding 1 GiB before runtime overhead. It is not a production memory design. A real consumer must stream unique BINs, retain them only while referenced, reconstruct bounded batches, validate framing against the manifest, and preserve authorization and snapshot cleanup. Browser decoder negotiation, memory use, and full navigation-to-ready time remain unverified.

### Server verification

The actual store's snapshot pin took 1.07–2.93 seconds in isolated repeats. Initial/rebased panel state can perform a full pin to derive its view, followed by another full pin for the scene ticket; matching saved views avoid the first. All asset HTTP reads then verify their bytes again. The store mutex serializes these operations.

A separate Effect prototype retained all path, symlink, size, and SHA checks and compared sequential verification with four concurrent verifications in sequential 32 MiB cohorts. An asset larger than the budget runs alone. Same-window medians were **1,010 ms sequential versus 596 ms in cohorts**, a 41% reduction in this stage. Observed RSS growth was 42.54 versus 49.64 MiB. A 64 MiB budget produced the same cohorts on this dataset, so it adds no demonstrated benefit.

Injected failure/cancellation tests confirmed that later cohorts do not start and all active uninterruptible reads settle before releasing the store lock. The budget limits declared input bytes, not hard RSS. The narrow candidate is to change only `loadUnlocked`; publication and deletion exclusion remain unchanged. Avoiding duplicate initial-state verification needs additional integration tests because it changes when missing/corrupt geometry becomes visible to the UI.

### Client CPU, copies, and scheduling

Two offline runs measured validation + GLTF parsing + material preparation + scene construction at **0.56–0.69 seconds**; receive-buffer copies took **0.40–0.45 seconds**. GLTFLoader allocated about 644 MB cumulatively through slices, with sampled ArrayBuffer peaks around 390–402 MB. This is allocation churn, not 644 MB permanently retained.

The 1,208 part occurrences share 755 geometry objects. There is no per-occurrence geometry-copy explosion. These Node results exclude actual browser decompression, WebGL shader compilation/uploads, and GPU execution, so they do not rule out a browser-specific stall.

A synthetic simulation using actual asset sizes/order tested 32, 64, and 96 MiB prefetch windows. Under shared aggregate-bandwidth assumptions, larger windows saved only 0–0.27 seconds; an invented per-stream cap saved about 1.15 seconds. These are not measured browser speedups. Window expansion is low priority without a live trace showing unused link capacity.

### Transport and next experiment

A 3.18 MB static asset on the same server transferred over loopback in 26 ms and through the server's own Tailscale endpoint in 294 ms, including 235 ms to first byte. This excludes CAD verification, remote Wi-Fi, and browser decoding; it does not establish the remote client's throughput. Remote preview evaluation subsequently timed out even for `1 + 1`, so no new remote end-to-end claim was made.

The next meaningful browser experiment is a prepared exact-dedup pack plus bounded verification, with the existing complete-scene publication requirement. Measure preparation separately from navigation, verify every reconstructed GLB, record peak memory and first-frame timing, and retain the progress fallback unless repeated original-detail loads actually meet ten seconds.

Local reproducible harnesses and detailed reports are retained under `.scratch/perf-data/`, `.scratch/perf-server/`, and `.scratch/perf-client/`. They are diagnostic artifacts, not production code; initial concurrent timings were discarded where isolated controls were available.
