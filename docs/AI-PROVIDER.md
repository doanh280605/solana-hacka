# Runtime AI configuration

osid uses an application server adapter, not an assistant tool, for live work. The official integration references are [Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [background responses](https://developers.openai.com/api/docs/guides/background), and [Image Edits](https://developers.openai.com/api/reference/resources/images/methods/edit). Models are configurable; defaults are `gpt-4.1-mini` and `gpt-image-1.5`.

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

At initial inspection on November 6, 2026 no runtime provider credential was configured. Stripe Projects CLI was available/authenticated, but there was no initialized project and its OpenAI catalog search returned no service. No provisioning or paid terms were accepted. The user was asked once to configure an existing key; live verification must remain outstanding until successful runtime evidence exists.
