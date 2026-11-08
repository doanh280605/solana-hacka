# Runtime AI configuration

osid uses an application server adapter, not an assistant tool, for live work. The official integration references are [Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [background responses](https://developers.openai.com/api/docs/guides/background), and [Image Edits](https://developers.openai.com/api/reference/resources/images/methods/edit). Models are configurable; defaults are `gpt-4.1-mini` and `gpt-image-1.5`.

The current [official image guide](https://developers.openai.com/api/docs/guides/image-prompting) schedules `gpt-image-1.5` retirement for December 1, 2026. Revalidate a replacement model and identity preservation before operating beyond that date. This verification keeps its explicitly configured model; it never silently migrates a paid request.

Put an existing funded API credential in the ignored root `.env`, never in browser variables, committed files, screenshots or logs:

```dotenv
AI_MODE=live
OPENAI_API_KEY=YOUR_EXISTING_KEY
OPENAI_TEXT_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-1.5
AI_TIMEOUT_MS=240000
```

The account must have permission to use the selected text and image models and enough existing credit. This implementation does not buy a plan, accept provider terms, or create a billing commitment. A missing key makes live quotes unavailable. A provider error is surfaced safely; it never silently selects a different model or fixture.

`AI_MODE=fixture` is an explicit development mode. Its image transformations and text are deterministic fixtures and do not demonstrate live AI. `/demo` always identifies its prebuilt content as sample data, including synthetic sample photographs created with the assistant ImageGen tool.

## What is sent and generated

Before funding, the text model interprets the seller's brief into exact source facts and a proposed image direction. Fixed service deliverables, copy limits, acceptance checks and limitations become a versioned specification. The quote commits its hash plus the original upload hash, parties, mint, amount, quote validity and execution deadline. The buyer sees these terms before signing funding.

After independently verified finalized funding, the model generates listing title, description and five bullets grounded in seller facts. The image model edits the actual uploaded product image, preserving its shape, label, packaging, count and color, while changing the setting/light/composition. Fixed social formats derive from that AI-edited image. Provider prompts prohibit invented prices, specifications, certifications and unsupported claims. The buyer must still review the work: prompts and deterministic guards cannot prove truth or visual identity preservation.

Live listing requests contain only the agreed `productFacts` and copy limits; the raw brief, photo and image direction are excluded. The model assembles complete approved fact phrases into a title, description and five bullets. A conservative live-only guard rejects new content words, changed phrase associations and numeric clauses that differ from an entire approved measurement fact. Benefit checks also retain negations, conditions and qualifiers. This can reject reasonable paraphrases; it is a bounded grounding rule, not a semantic truth detector. Historical committed delivery is verified against its original manifest bytes, without applying a newer editorial policy to frozen results.

An exact-fact worked example aligns the prompt with this grammar. Listing requests set temperature 0 only for the configured GPT-4.1 Mini alias or dated snapshots; other configured models omit that option. Low temperature does not guarantee compliance, so every live output still passes the unchanged guard and buyer review. A live test also demonstrated safe rejection of factually grounded connecting prose before an image request or submission; this conservative false positive is recorded separately from actual unsupported claims.

During live verification, buyer review rejected two real packs before release: one invented durability/freshness benefits; another reassigned a jar quantity to wax weight and copied photographic directions into listing copy. Those immutable jobs and provider attempts remain recorded separately. Corrected generation uses a new quote/job, never a hidden replacement of a submitted result.

## Limits and deadlines

- Upload: one decoded single-frame PNG, JPEG or WebP, at most 5 MiB, each edge at most 4096 pixels.
- Brief: 20–2000 characters.
- Default quote validity: 600 chain seconds; execution/refund deadline: 1800 seconds after quote. They are distinct commitments.
- Default provider timeout: 240 seconds; text stages have a shorter bounded polling budget. `AI_TIMEOUT_MS` accepts 1000–600000 ms.
- Default rate: six quotes per wallet per hour; at most two active generation jobs per process. Configure `OSID_MAX_QUOTES_PER_HOUR` and `OSID_MAX_CONCURRENT_GENERATIONS` within the validated bounds.
- The explicit stall switch is disabled unless `OSID_ALLOW_REHEARSAL_STALL=true`. Shorter deadlines in evidence are isolated test settings, not the ordinary AI service promise.

## Crash safety and reconciliation

Every chargeable stage gets a durable random attempt identifier before its request. Request/response IDs and returned stage data persist before advancing. Responses background jobs have retrievable IDs; recovery uses GET polling where an ID was durably recorded. Read-only retries are bounded. The adapter does not assume `X-Client-Request-Id` provides idempotency.

A timeout or crash before a retrievable ID/result is durably stored leaves an uncertain attempt. osid stops and exposes the chain refund time; it does not blindly repeat a chargeable POST. Synchronous Image Edits cannot be reconstructed from a request ID alone. Inspect the provider dashboard/request records before any manual intervention. Never delete an attempt record merely to make a retry happen.

Returned originals, four previews, listing, validation, manifest and ZIP persist before provider submission. The exact signed submission transaction is durable before sending; a retry reuses those bytes. Restart reconciles finalized chain state and the recorded result. Submitted or paid output is never silently regenerated if storage is missing or corrupt. Restore the original byte-identical files from an operator backup, or report storage unavailability honestly.

Files are private to the OS user and never served statically. Delivery requires finalized Released, the original buyer's separate download signature and an exact match between stored order, manifest, chain result hash, payloads and bundle. Storage backups improve ordinary availability; they are not cryptographic fair exchange or guaranteed permanence.

## Credential discovery observation

At initial inspection on November 6, 2026 no runtime provider credential was configured. Stripe Projects CLI was available/authenticated, but there was no initialized project and its OpenAI catalog search returned no service. No provisioning or paid terms were accepted. The user then configured an existing credential in ignored `.env`. A read-only models request confirmed access to the configured models; [sanitized access evidence](../evidence/osid-provider-access.json). Access alone does not establish successful end-to-end delivery; the current result is recorded in [STATUS.md](STATUS.md).

Official documentation was rechecked during integration on November 6 Pacific (November 7 UTC): the [GPT-4.1 Mini model page](https://developers.openai.com/api/docs/models/gpt-4.1-mini) lists Responses, image inputs and structured outputs; the [Image Edits reference](https://developers.openai.com/api/reference/resources/images/methods/edit) lists `gpt-image-1.5`, high input fidelity and base64 image output. Background retrieval follows the linked official guide. These schema checks do not verify account access, model behavior or successful runtime generation. The optional OpenAI platform-key tool was not available in this session.
