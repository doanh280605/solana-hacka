import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { buildApproveV2Transaction, buildFundV2Transaction, fetchChainTime, fetchJob, type PublicConfig } from '@holdfast/chain';
import { ApiError, apiResponse, persistOrder, post, previewPath, request, savedOrders } from './api';
import { assertOrder, assertResult, hashBytes } from './commitments';
import { verifyBundle } from './bundle';
import { ChainDetails, DateTime, ListingView, MoneyReceipt, Notice, SpecificationView, ValidationReport, type NoticeValue, type TxRecord, type Wallet } from './components';
import { compiledConfig, errorMessage, validateConfig } from './config';
import { formatTokens, timeRemaining, useLedger } from './ledger';
import { sampleBrief } from './sample';
import { verifyPreviewBytes } from './previews';
import { encodeSignature, useSession } from './session';
import type { Order, PreviewCommitment, Purchase } from './types';
import { sendTransaction } from './wallet';

const baked = compiledConfig();
const statusLabels: Record<Purchase['status'], string> = { quoted: 'Quote ready', funded: 'Deposit confirmed', processing: 'Creating your pack', submitting: 'Confirming delivery', ready: 'Ready for your review', released: 'Payment released', refunded: 'Deposit refunded', failed: 'Generation needs attention' };

function PrivatePreview({ jobId, preview, commitment, proofKey, onLoaded, onInvalid }: { jobId: string; preview: NonNullable<Order['previews']>[number]; commitment: PreviewCommitment; proofKey: string; onLoaded: (key: string) => void; onInvalid: (key: string) => void }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let url: string | undefined;
    const controller = new AbortController();
    setSource(null); setError(null);
    onInvalid(proofKey);
    void (async () => {
      const response = await apiResponse(previewPath(jobId, preview.name, preview.url), { signal: controller.signal });
      const blob = await response.blob();
      await verifyPreviewBytes(await blob.arrayBuffer(), commitment, preview.name, blob.type);
      if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot safely decode a private WebP preview. Use a current browser.');
      const bitmap = await createImageBitmap(blob);
      const decoded = { width: bitmap.width, height: bitmap.height }; bitmap.close();
      if (decoded.width !== commitment.width || decoded.height !== commitment.height) throw new Error('Decoded preview dimensions differ from the submitted result.');
      if (!controller.signal.aborted) { url = URL.createObjectURL(blob); setSource(url); }
    })().catch((reason) => { if (!controller.signal.aborted) { onInvalid(proofKey); setError(errorMessage(reason)); } });
    return () => { controller.abort(); onInvalid(proofKey); if (url) URL.revokeObjectURL(url); };
  }, [jobId, preview.name, preview.url, commitment.sha256, commitment.bytes, commitment.width, commitment.height, commitment.path, commitment.sourcePath, commitment.mimeType, proofKey, onInvalid]);
  return <figure className={`private-preview preview-${preview.name}`}><div>{source ? <img src={source} alt={`${preview.name} image preview — inspect the product identity before approval`} onLoad={(event) => { if (event.currentTarget.naturalWidth === commitment.width && event.currentTarget.naturalHeight === commitment.height) onLoaded(proofKey); else { onInvalid(proofKey); setError('Displayed preview dimensions differ from the submitted result.'); } }} onError={() => { onInvalid(proofKey); setError('Preview image could not be displayed. Reload the order before approving.'); }} /> : <p role="status">{error || 'Verifying private preview…'}</p>}</div><figcaption><strong>{preview.name === 'hero' ? 'Product hero' : preview.name}</strong><span>{commitment.width} × {commitment.height} · verified private preview</span></figcaption>{error && <p className="inline-warning" role="alert">{error}</p>}</figure>;
}

export function WorkspacePage({ wallet }: { wallet: Wallet }) {
  const [config, setConfig] = useState<PublicConfig | null>(baked.config);
  const [configError, setConfigError] = useState<string | null>(baked.error);
  const [service, setService] = useState<{ aiMode: 'live' | 'fixture'; liveConfigured: boolean; rehearsalStallEnabled: boolean; service: string } | null>(null);
  const auth = useSession(wallet, config?.cluster || baked.config?.cluster || 'devnet');
  const authenticated = auth.session?.wallet === wallet.address && auth.session.expiresAt * 1000 > Date.now();
  const activeWallet = useRef(wallet.address); activeWallet.current = wallet.address;
  const [order, setOrder] = useState<Order | null>(null);
  const selected = order?.buyer === wallet.address ? order : null;
  const [history, setHistory] = useState<Purchase[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [brief, setBrief] = useState('');
  const [mode, setMode] = useState<'normal' | 'stall'>('normal');
  const [sampleInput, setSampleInput] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [loadedPreviews, setLoadedPreviews] = useState<string[]>([]);
  const [verifiedPack, setVerifiedPack] = useState<Order | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [records, setRecords] = useState<TxRecord[]>([]);
  const ledger = useLedger(config, selected?.jobAddress || null, wallet.address);
  const chainState = ledger.job?.state;
  const expired = !!selected && ledger.chainTime !== null && ledger.chainTime >= selected.expiresAt;
  const quoteExpired = !!selected && ledger.chainTime !== null && ledger.chainTime >= selected.quoteExpiresAt;
  const pack = selected && verifiedPack?.jobId === selected.jobId && verifiedPack.resultHash === selected.resultHash && verifiedPack.resultHash === ledger.job?.resultHash ? verifiedPack : null;
  const previewReady = !!pack && (chainState === 'Submitted' || chainState === 'Released');
  const previewProofKey = (entry: PreviewCommitment) => `${wallet.address}:${pack?.jobId}:${pack?.resultHash}:${entry.path}:${entry.sha256}`;
  const allPreviewsLoaded = previewReady && pack.manifest!.previews.every((entry) => loadedPreviews.includes(previewProofKey(entry)));

  useEffect(() => {
    let alive = true;
    void request<unknown>('/api/config').then(validateConfig).then((value) => {
      if (!alive) return;
      if (!baked.config) throw new Error(baked.error || 'Trusted recovery configuration is missing.');
      const mismatch = (['programId', 'mint', 'merchant', 'provider', 'cluster', 'rpcUrl'] as const).some((field) => value[field] !== baked.config![field]);
      if (mismatch || !value.provider) throw new Error('Service settings differ from this trusted recovery client. Align the public configuration and rebuild before funding.');
      setConfig(value); setConfigError(null);
    }).catch((reason) => { if (alive) setConfigError(errorMessage(reason)); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    void request<{ aiMode: 'live' | 'fixture'; liveConfigured: boolean; rehearsalStallEnabled: boolean; service: string }>('/api/v2/service').then((value) => {
      if (!['live', 'fixture'].includes(value.aiMode) || value.service !== 'product-listing-pack') throw new Error('Unsupported listing service configuration.');
      if (alive) setService(value);
    }).catch((reason) => { if (alive) setApiError(errorMessage(reason)); });
    return () => { alive = false; };
  }, []);

  const remember = useCallback((value: Order) => {
    if (value.buyer !== activeWallet.current || value.version !== 2) return;
    setOrder(value); persistOrder(value);
    setHistory((previous) => [value, ...previous.filter((item) => item.jobAddress !== value.jobAddress)].slice(0, 40));
  }, []);
  const handleApiError = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 401) auth.invalidate();
    setApiError(errorMessage(reason));
  }, [auth.invalidate]);

  useEffect(() => {
    setOrder(null); setHistory(wallet.address ? savedOrders(wallet.address) : []);
    setFile(null); setBrief(''); setSampleInput(false); setRecords([]); setNotice(null);
    setAccepted(false); setReviewed(false); setApiError(null);
  }, [wallet.address]);

  useEffect(() => {
    if (!authenticated || !wallet.address || !config) return;
    let alive = true;
    const stored = savedOrders(wallet.address);
    void request<{ orders: Order[] }>('/api/v2/orders').then(async ({ orders }) => {
      if (!Array.isArray(orders)) throw new Error('The order history response is invalid.');
      if (!alive) return;
      const values = orders.filter((item) => item.version === 2 && item.buyer === wallet.address).sort((a, b) => b.expiresAt - a.expiresAt);
      setHistory([...values, ...stored.filter((old) => !values.some((item) => item.jobAddress === old.jobAddress))]);
      const restore = values.find((item) => item.jobId === stored[0]?.jobId) || values[0];
      if (restore) { await assertOrder(restore, config, wallet.address!); if (alive) remember(restore); }
      setApiError(null);
    }).catch((reason) => { if (alive) handleApiError(reason); });
    return () => { alive = false; };
  }, [authenticated, wallet.address, config, remember, handleApiError]);

  useEffect(() => {
    if (!selected || !authenticated || !config || !wallet.address) return;
    let alive = true; let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const value = await request<Order>(`/api/v2/orders/${selected.jobId}`);
        await assertOrder(value, config, wallet.address!);
        if (alive) { remember(value); setApiError(null); }
      } catch (reason) { if (alive) handleApiError(reason); }
      finally { polling = false; }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 12_000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [selected?.jobId, authenticated, config, wallet.address, remember, handleApiError]);

  useEffect(() => {
    setAccepted(false); setReviewed(false); setLoadedPreviews([]); setVerifiedPack(null); setResultError(null);
  }, [wallet.address, selected?.jobId, selected?.resultHash]);
  useEffect(() => {
    if (!selected || !ledger.job || !authenticated || !['ready', 'released'].includes(selected.status)) { setVerifiedPack(null); return; }
    let alive = true;
    void assertResult(selected, ledger.job).then(() => { if (alive) { setVerifiedPack(selected); setResultError(null); } }).catch((reason) => { if (alive) { setVerifiedPack(null); setResultError(errorMessage(reason)); } });
    return () => { alive = false; };
  }, [selected, ledger.job, authenticated]);
  useEffect(() => {
    if (!file) { setFilePreview(null); return; }
    const url = URL.createObjectURL(file); setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const previewLoaded = useCallback((key: string) => setLoadedPreviews((previous) => previous.includes(key) ? previous : [...previous, key]), []);
  const previewInvalid = useCallback((key: string) => setLoadedPreviews((previous) => previous.includes(key) ? previous.filter((item) => item !== key) : previous), []);
  const record = (action: string) => (signature: string) => setRecords((previous) => [{ action, signature }, ...previous]);

  async function action(label: string, work: () => Promise<void>) {
    setBusy(label); setNotice(null);
    try { await work(); }
    catch (reason) { if (reason instanceof ApiError && reason.status === 401) auth.invalidate(); setNotice({ kind: 'error', text: errorMessage(reason) }); }
    finally { setBusy(null); await ledger.refresh(); }
  }
  function requireSession() {
    if (!authenticated || wallet.provider?.publicKey?.toString() !== wallet.address) throw new Error('Sign in with the connected buyer wallet before continuing.');
  }
  async function createQuote(event: FormEvent) {
    event.preventDefault();
    if (!wallet.address || !file || !config || configError) return;
    await action('Interpreting your brief…', async () => {
      requireSession();
      const cleanBrief = brief.trim();
      if (cleanBrief.length < 20 || cleanBrief.length > 2000) throw new Error('Write a brief between 20 and 2,000 characters. Include only product facts you can verify.');
      if (file.size > 5 * 1024 * 1024 || file.size === 0) throw new Error('Choose a product photo no larger than 5 MiB.');
      const bytes = await file.arrayBuffer(); const head = new Uint8Array(bytes);
      const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => head[index] === value);
      const jpeg = head[0] === 255 && head[1] === 216 && head[2] === 255;
      const webp = new TextDecoder().decode(head.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(head.slice(8, 12)) === 'WEBP';
      if (!png && !jpeg && !webp) throw new Error('Choose a valid PNG, JPEG or WebP product photo.');
      const inputHash = await hashBytes(bytes);
      const data = new FormData(); data.append('buyer', wallet.address!); data.append('brief', cleanBrief); data.append('mode', mode); data.append('file', file);
      const value = await request<Order>('/api/v2/orders', { method: 'POST', body: data });
      await assertOrder(value, config, wallet.address!);
      if (value.inputHash !== inputHash || value.specification.brief !== cleanBrief) throw new Error('The quoted specification does not bind your uploaded photo and exact brief.');
      remember(value); setRecords([]); setNotice({ text: 'Your specification is ready. Review the facts, deliverables and deadlines before funding. No tokens have moved.' });
    });
  }
  async function fund() {
    if (!selected || !config || configError || !wallet.address || !ledger.connection || !accepted) return;
    await action('Confirm funding in your wallet…', async () => {
      requireSession();
      const current = await fetchJob(ledger.connection!, config, selected.jobAddress);
      await assertOrder(selected, config, wallet.address!, current);
      let signature: string | undefined;
      if (current && !['Funded', 'Submitted'].includes(current.state)) throw new Error('This order is already settled. Refresh its receipt.');
      if (!current) {
        if (await fetchChainTime(ledger.connection!) >= selected.quoteExpiresAt) throw new Error('This quote has expired. Start a new pack to get updated terms.');
        const transaction = await buildFundV2Transaction(ledger.connection!, config, { buyer: wallet.address!, jobId: selected.jobId, amount: selected.amount, provider: selected.provider, expiresAt: selected.expiresAt, quoteExpiresAt: selected.quoteExpiresAt, inputHash: selected.inputHash, specHash: selected.specHash, termsHash: selected.termsHash });
        signature = await sendTransaction(ledger.connection!, wallet.provider, wallet.address!, transaction, record('Fund product-listing pack'));
      }
      remember(await post<Order>(`/api/v2/orders/${selected.jobId}/funded`, { signature }));
      setNotice({ kind: 'success', text: 'Your deposit is finalized in escrow. Generation starts after the service independently verifies it.' });
    });
  }
  async function approve() {
    if (!selected || !config || !wallet.address || !ledger.connection || !reviewed || !allPreviewsLoaded) return;
    await action('Confirm payment release in your wallet…', async () => {
      requireSession();
      const latest = await request<Order>(`/api/v2/orders/${selected.jobId}`);
      const current = await fetchJob(ledger.connection!, config, selected.jobAddress);
      await assertOrder(latest, config, wallet.address!, current);
      if (!current || current.state !== 'Submitted' || selected.resultHash !== latest.resultHash) throw new Error('This exact result is no longer awaiting approval. Refresh the order.');
      await assertResult(latest, current);
      if (await fetchChainTime(ledger.connection!) >= current.expiresAt) throw new Error('The approval deadline has passed. Open recovery to sign your refund.');
      const transaction = await buildApproveV2Transaction(ledger.connection!, config, { buyer: wallet.address!, jobAddress: selected.jobAddress, resultHash: latest.resultHash! });
      await sendTransaction(ledger.connection!, wallet.provider, wallet.address!, transaction, record('Approve work & release payment'));
      setNotice({ kind: 'success', text: 'Payment released. Sign a separate ownership challenge to download your private bundle.' });
      remember(await request<Order>(`/api/v2/orders/${selected.jobId}`));
    });
  }
  async function resumeFunding() {
    if (!selected) return;
    await action('Verifying your funded order…', async () => { requireSession(); remember(await post<Order>(`/api/v2/orders/${selected.jobId}/funded`, {})); });
  }
  async function download() {
    if (!selected || !wallet.address || !wallet.provider?.signMessage || !config || !ledger.connection) return;
    await action('Sign download ownership in your wallet…', async () => {
      requireSession();
      const current = await fetchJob(ledger.connection!, config, selected.jobAddress);
      await assertOrder(selected, config, wallet.address!, current);
      if (!current || current.state !== 'Released') throw new Error('Wait for finalized payment release before downloading.');
      await assertResult(selected, current);
      const challenge = await post<{ nonce: string; message: string; expiresAt: number }>(`/api/v2/orders/${selected.jobId}/challenge`, { buyer: wallet.address });
      if (!challenge.message.includes(selected.jobId) || !challenge.message.includes(selected.jobAddress) || !challenge.message.includes(wallet.address!) || challenge.expiresAt * 1000 <= Date.now()) throw new Error('The download challenge does not match this buyer and order.');
      const signed = await wallet.provider!.signMessage!(new TextEncoder().encode(challenge.message), 'utf8');
      if (wallet.provider!.publicKey?.toString() !== selected.buyer) throw new Error('Wallet changed. Reconnect the original buyer.');
      const response = await apiResponse(`/api/v2/orders/${selected.jobId}/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buyer: wallet.address, nonce: challenge.nonce, signature: encodeSignature(signed.signature) }) });
      const blob = await response.blob();
      if (!['application/zip', 'application/octet-stream'].includes(blob.type) || blob.size < 4) throw new Error('The service did not return a complete ZIP bundle.');
      const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) throw new Error('The downloaded bundle is not a valid ZIP file.');
      await verifyBundle(await blob.arrayBuffer(), selected.manifest!, selected.resultHash!);
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `osid-${selected.jobId.slice(0, 10)}.zip`; document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice({ kind: 'success', text: 'Your private bundle is downloaded. It contains the four images, listing copy, validation report and committed manifest. Keep a local copy.' });
    });
  }
  async function selectPurchase(purchase: Purchase) {
    if (purchase.version !== 2) { window.location.href = `/recover?job=${encodeURIComponent(purchase.jobAddress)}`; return; }
    await action('Opening your pack…', async () => { requireSession(); const value = await request<Order>(`/api/v2/orders/${purchase.jobId}`); if (config && wallet.address) await assertOrder(value, config, wallet.address); remember(value); setRecords([]); });
  }
  async function useSample() {
    await action('Loading sample input…', async () => { const blob = await (await fetch('/sample-before.webp')).blob(); setFile(new File([blob], 'morning-sample.webp', { type: 'image/webp' })); setBrief(sampleBrief); setSampleInput(true); });
  }
  const stage = chainState === 'Released' ? 4 : chainState === 'Submitted' && previewReady ? 3 : chainState === 'Funded' || chainState === 'Submitted' ? 2 : selected ? 1 : 0;

  return <main id="main" className="page-width workspace-page"><div className="workspace-intro"><div><span className="eyebrow">YOUR PRODUCT. READY FOR ITS NEXT CHAPTER.</span><h1>Make a little<br /><em>more of it.</em></h1></div><p>One photo. A precise brief. A listing pack you review.<br />Your payment stays in escrow until you approve.</p></div><div className="workspace-grid"><div className="work-column"><section className="session-strip" aria-label="Wallet sign-in"><div><span className="eyebrow">{authenticated ? 'SIGNED IN' : 'START WITH YOUR WALLET'}</span><p>{authenticated ? 'Your workspace is private to this wallet.' : 'Connect, then sign a login message to create and review a pack.'}</p><span className="fine-print">Sign-in never authorizes a payment, release or refund.</span></div>{authenticated ? <button className="text-button" disabled={auth.busy} onClick={() => void auth.signOut()}>Sign out</button> : !wallet.address ? <button className="button secondary" onClick={() => void wallet.connect()} disabled={wallet.connecting}>Connect wallet</button> : <button className="button primary" onClick={() => void auth.signIn()} disabled={auth.busy || !!busy}>{auth.busy ? 'Confirm sign-in message…' : 'Sign in with wallet'}</button>}</section><Notice value={wallet.error ? { text: wallet.error, kind: 'error' } : null} /><Notice value={auth.error ? { text: auth.error, kind: 'error' } : null} /><Notice value={configError ? { text: configError, kind: 'error' } : null} /><Notice value={notice} />{!selected && service?.aiMode === 'fixture' && <Notice value={{ text: 'Development fixture mode is active. Packs use sample generation; this is not live AI. Wallet and escrow actions still use real test-network transactions.' }} />}{!selected && service?.aiMode === 'live' && !service.liveConfigured && <Notice value={{ kind: 'error', text: 'Live AI is selected, but the provider is not configured. Quotes are unavailable until the service operator adds its server-side provider credentials.' }} />}{apiError && <Notice value={{ text: `${apiError}${selected ? ' The independent recovery page remains available without this service or sign-in.' : ''}`, kind: 'error' }} />}{ledger.error && <Notice value={{ text: `Solana reading unavailable: ${ledger.error}`, kind: 'error' }} />}
      {selected && authenticated ? <><div className="order-heading"><div><span className="eyebrow">YOUR LISTING PACK</span><h2>{statusLabels[selected.status] || selected.status}</h2></div><button className="text-button" disabled={!!busy} onClick={() => { setOrder(null); setNotice(null); setRecords([]); }}>Start another pack</button></div><div className="order-tags"><span className={`tag ${selected.aiMode === 'fixture' ? 'fixture' : ''}`}>{selected.aiMode === 'fixture' ? 'Fixture AI · development only' : 'Live AI provider'}</span><span className="tag">V2 agreement</span>{selected.mode === 'stall' && <span className="tag fixture">Recovery rehearsal · no generation</span>}</div>{selected.aiMode === 'fixture' && <Notice value={{ text: 'This order uses deterministic fixture content. It does not demonstrate live AI generation. Funding and settlement still use real test-network transactions.' }} />}<ol className="order-progress" aria-label="Order progress">{['Brief', 'Agreement', 'Generation', 'Review', 'Delivery'].map((title, index) => <li key={title} className={index < stage ? 'done' : index === stage ? 'active' : ''} aria-current={index === stage ? 'step' : undefined}><span>0{index + 1}</span>{title}</li>)}</ol>
        {(!chainState || chainState === 'Funded') && <SpecificationView specification={selected.specification} />}
        {!chainState ? <section className="fund-panel"><div className="quote-deadlines"><div><span className="label">QUOTE VALID UNTIL</span><strong><DateTime seconds={selected.quoteExpiresAt} /></strong></div><div><span className="label">REFUND AVAILABLE AT</span><strong><DateTime seconds={selected.expiresAt} /></strong></div></div><p>Fund exactly <strong>{formatTokens(selected.amount)} mock USDC</strong>. The execution window starts at quote creation. Approval must happen before the refund deadline.</p><label className="consent"><input id="accept-specification" type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>I accept this specification, the fixed price and deadlines.{selected.aiMode === 'fixture' && ' I understand this order uses fixture AI.'}</span></label><button className="button primary full" onClick={() => void fund()} disabled={!accepted || !!busy || !!configError || !ledger.connection || ledger.chainTime === null || !!ledger.error || quoteExpired}>{busy || (quoteExpired ? 'Quote expired · start another pack' : 'Fund 5 mock USDC')}</button><p className="fine-print">A separate wallet transaction moves the deposit into the program vault. The seller cannot approve on your behalf.</p></section> : null}
        {(chainState === 'Funded' || chainState === 'Submitted') && !previewReady && <section className="generation-panel" aria-live="polite"><span className={`generation-line ${selected.mode === 'stall' || selected.status === 'failed' ? 'paused' : ''}`} /><span className="eyebrow">{expired ? 'REFUND WINDOW OPEN' : selected.status === 'failed' ? 'GENERATION NEEDS ATTENTION' : selected.mode === 'stall' ? 'RECOVERY REHEARSAL' : chainState === 'Submitted' ? 'CHECKING THE DELIVERY' : 'WORK IN PROGRESS'}</span><h3>{expired ? 'You can recover your deposit.' : selected.status === 'failed' ? 'The pack could not be completed.' : selected.mode === 'stall' ? 'This order intentionally waits.' : 'Making room for your product.'}</h3><p>{expired ? 'The chain deadline has arrived. A refund requires your wallet confirmation; it does not happen automatically.' : selected.status === 'failed' ? selected.error || 'The provider did not produce a complete pack. Your deposit remains in escrow until you approve or refund.' : selected.mode === 'stall' ? 'Generation is disabled for this explicit recovery rehearsal. Use independent recovery when the deadline arrives.' : 'The service edits the hero, writes the listing, builds the exports and checks the complete bundle before committing the result on Solana.'}</p><p>Refund available <DateTime seconds={selected.expiresAt} />.</p>{!expired && <span className="fine-print">{timeRemaining(selected.expiresAt, ledger.chainTime)} until refund eligibility. Keep this order’s recovery link.</span>}{selected.status === 'quoted' && <button className="button secondary" disabled={!!busy} onClick={() => void resumeFunding()}>Resume funded order</button>}</section>}
        {resultError && <Notice value={{ text: resultError, kind: 'error' }} />}
        {previewReady && <><section className="review-heading"><span className="eyebrow">YOUR WORK, BEFORE YOU RELEASE PAYMENT</span><h3>Take a closer look.</h3><p>Review the product itself, its label and every line of copy. The measurable checks below support your review.</p></section><div className="preview-grid">{pack!.previews!.map((preview) => { const commitment = pack!.manifest!.previews.find((entry) => entry.path === `preview-${preview.name}.webp`)!; const proofKey = previewProofKey(commitment); return <PrivatePreview key={proofKey} jobId={pack!.jobId} preview={preview} commitment={commitment} proofKey={proofKey} onLoaded={previewLoaded} onInvalid={previewInvalid} />; })}</div><ListingView listing={pack!.listing!} /><ValidationReport validation={pack!.validation!} />{chainState === 'Submitted' && <section className="approval-panel"><h3>Your call.</h3><p>Approval releases exactly <strong>{formatTokens(selected.amount)} mock USDC</strong> to the recorded merchant for this submitted result. Payment release is final.</p><label className="consent"><input id="approve-review" type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /><span>I reviewed all four images and the listing copy. The product identity and supplied facts are acceptable.</span></label><button className="button primary full" disabled={!reviewed || !allPreviewsLoaded || !!busy || expired || !!ledger.error} onClick={() => void approve()}>{busy || (expired ? 'Approval closed · open recovery' : 'Approve & release 5 mock USDC')}</button>{!allPreviewsLoaded && <p className="fine-print">All four image previews must load before approval.</p>}</section>}</>}
        {chainState === 'Released' && <section className="download-panel"><span className="eyebrow">THE HANDOFF</span><h3>All yours.</h3><p>Get the four full-size images, listing.json, validation.json and manifest.json in one private ZIP. The service verifies the stored payload hashes against the committed manifest before serving it.</p><button className="button primary full" onClick={() => void download()} disabled={!!busy || !previewReady || !wallet.provider?.signMessage}>{busy || 'Sign & download bundle'}</button><p className="fine-print">This separate message proves file ownership. Keep a copy: delivery depends on available merchant storage.</p></section>}
        {chainState === 'Refunded' && <Notice value={{ kind: 'success', text: 'This order is refunded. The exact recorded payment returned to the original buyer. Start another pack whenever you’re ready.' }} />}
        <div className="order-links"><a className="inline-link" href={`/recover?job=${encodeURIComponent(selected.jobAddress)}`}>Save or open independent recovery</a><button className="text-button" onClick={() => void ledger.refresh()} disabled={ledger.loading}>{ledger.loading ? 'Reading chain…' : 'Refresh payment state'}</button></div><ChainDetails config={config} job={ledger.job} order={selected} records={records} /></> : <><div className="order-heading"><div><span className="eyebrow">01 / YOUR STARTING POINT</span><h2>Bring your product.</h2></div><button className="text-button" onClick={() => void useSample()} disabled={!!busy}>Use sample input</button></div><form className="brief-form" onSubmit={(event) => void createQuote(event)}><label className={`dropzone ${file ? 'has-file' : ''}`} htmlFor="product-file">{filePreview ? <img src={filePreview} alt="Your selected product photo" /> : <span className="upload-number" aria-hidden="true">01</span>}<div><strong>{file?.name || 'A photo with potential.'}</strong><span>{file ? `${(file.size / 1024).toFixed(0)} KiB · choose to replace` : 'Choose a product photo'}</span><small>PNG, JPEG or WebP · up to 5 MiB · max 4096 × 4096</small></div><input id="product-file" name="file" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { setFile(event.target.files?.[0] || null); setSampleInput(false); }} /></label>{sampleInput && <p className="inline-warning">Synthetic candle sample input. Your new order will use the worker’s configured live or fixture AI mode.</p>}<label className="brief-label" htmlFor="brief">Tell us what you’re selling.</label><p className="field-hint" id="brief-hint">Share the product name, materials, size and verified details. Describe the setting you want. Leave out anything you can’t support.</p><textarea id="brief" name="brief" value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="A handmade ceramic mug, 300 ml, matte blue glaze. Keep the exact shape and handle. Create a clean, warm studio setting. No added specifications or claims." minLength={20} maxLength={2000} rows={6} aria-describedby="brief-hint brief-count" required /><span className="character-count" id="brief-count">{brief.length} / 2,000 characters · minimum 20</span><div className="included-summary"><span className="eyebrow">THE PACK / 5 MOCK USDC</span><p>1 edited hero · 3 social exports · listing copy<br />Validation report · private ZIP &amp; artifact manifest</p></div><button type="submit" className="button primary full" disabled={!authenticated || !file || brief.trim().length < 20 || !!busy || !config || !!configError || !service || (service.aiMode === 'live' && !service.liveConfigured)}>{busy || 'Get quote'}</button><p className="fine-print">AI interprets your brief into an agreement first. Review it before funding. Your photo stays private to the service and its AI provider.</p>{service?.rehearsalStallEnabled && <details className="rehearsal-options"><summary>Recovery rehearsal options</summary><label className="consent"><input type="checkbox" checked={mode === 'stall'} onChange={(event) => setMode(event.target.checked ? 'stall' : 'normal')} /><span>Intentionally skip generation to test timeout recovery. This creates no deliverable pack.</span></label></details>}</form></>}
      {history.filter((item) => item.buyer === wallet.address).length > 0 && <section className="order-history"><div className="section-heading"><div><span className="eyebrow">BACK ON THE SHELF</span><h3>Your orders</h3></div></div><ul>{history.filter((item) => item.buyer === wallet.address).map((item) => <li key={item.jobAddress}><div><strong>{item.version === 2 ? 'Product-listing pack' : 'Legacy V1 purchase'}</strong><span>{new Date(item.expiresAt * 1000).toLocaleDateString()} · {statusLabels[item.status] || item.status}</span></div>{item.version === 2 && authenticated ? <button className="text-button" onClick={() => void selectPurchase(item)} disabled={!!busy}>{item.jobId === selected?.jobId ? 'Current order' : 'Open order'}</button> : <a href={`/recover?job=${encodeURIComponent(item.jobAddress)}`}>Recovery</a>}</li>)}</ul></section>}
    </div><MoneyReceipt config={config} order={selected} job={ledger.job} balances={ledger.balances} chainTime={ledger.chainTime} loading={ledger.loading} error={ledger.error} /></div></main>;
}
