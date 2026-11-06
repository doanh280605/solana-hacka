# Two-minute demo script

Use the cluster with passing evidence. A Devnet claim requires the real Devnet program and transaction links. The normal manual deadline is 120 seconds; rehearse the expiry timing before recording, or use a 90-second demo quote and start the stalled job before the first shot. Do not hide which network or wallet the recording uses.

| Time | Say | Show |
| --- | --- | --- |
| 0:00–0:12 | “This is Holdfast for the Solana Hackathon. When an automated merchant takes your payment and then disappears, you need a refund that does not depend on that merchant.” | Checkout, network, $5 price and money receipt. |
| 0:12–0:30 | “I upload one PNG and deposit five test USDC. The program records my wallet, the merchant, mint, amount and deadline.” | Real upload and wallet approval; buyer balance falls by five, vault rises by five. Open the real funding transaction. |
| 0:30–0:45 | “The original WebP is already saved. I see a watermarked preview before I approve the payment.” | Ready preview and durable result evidence. |
| 0:45–1:02 | “Only I can release this deposit. Approval moves exactly five tokens to the merchant. A signed challenge unlocks the original, and reconnecting restores access.” | Approve; vault zero, merchant +5; sign download; reload and download again. |
| 1:02–1:17 | “Now the worker stalls. My second deposit stays in escrow. I will stop the merchant API entirely.” | Stalled job with vault 5; stop the owned worker; show failed health request/process exit. |
| 1:17–1:45 | “This recovery page only talks to Solana. Once the chain deadline arrives, my wallet signs a refund directly from the program.” | Independent `/recover?job=...`; API still offline; wallet refund; buyer +5, vault zero, merchant unchanged. Open refund transaction and Refunded job state. |
| 1:45–2:00 | “The program enforces the money rules. Files still depend on merchant storage. Holdfast makes the refund survive the merchant.” | Released and Refunded transaction links and the Devnet program address. |

Do not claim that escrow guarantees delivery, that refunds happen automatically, or that mock USDC is real USDC. The buyer signs the refund and pays SOL transaction fees separately. The private download requires both finalized release and control of the recorded buyer wallet.

Before recording: run the local and Devnet verification commands, fund the browser wallet with mock tokens, confirm a current blockhash/chain clock, use a clean order, and ensure the recovery app is already built/served separately from the API. The final public video and submission remain participant actions.
