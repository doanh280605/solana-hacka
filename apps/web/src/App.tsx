import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  buildApproveTransaction, buildFundTransaction, buildRefundTransaction, deriveJobAddress,
  explorerUrl, fetchChainTime, fetchJob, type Job, type PublicConfig,
} from '@holdfast/chain';
import { PublicKey } from '@holdfast/chain';
import { persistOrder, post, previewSource, request, savedOrders } from './api';
import { compiledConfig, errorMessage, validateConfig, workerUrl } from './config';
import { formatTokens, short, timeRemaining, useLedger, type Balances } from './ledger';
import type { Order } from './types';
import { sendTransaction, useWallet } from './wallet';

type Wallet = ReturnType<typeof useWallet>;
type NoticeValue = { text: string; kind?: 'error' | 'success' } | null;
type TxRecord = { signature: string; action: string };
const baked = compiledConfig();

export function App() {
  const wallet = useWallet();
  const recovery = window.location.pathname.replace(/\/$/, '') === '/recover';
  return (
    <>
      <a className="skip-link" href="#main">Skip to checkout</a>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Holdfast home"><span className="brand-mark" aria-hidden="true" />holdfast<span className="wordmark-dot">.</span></a>
        <nav aria-label="Main navigation">
          <a className={!recovery ? 'current' : ''} href="/">Checkout</a>
          <a className={recovery ? 'current' : ''} href="/recover">Recover funds</a>
        </nav>
        <WalletButton wallet={wallet} />
      </header>
      {recovery ? <RecoveryPage wallet={wallet} /> : <CheckoutPage wallet={wallet} />}
      <footer className="site-footer">
        <span>Built for work. Backed by a way back.</span>
        <span>Solana test network · Mock USDC · No real dollar value</span>
      </footer>
    </>
  );
}

function WalletButton({ wallet }: { wallet: Wallet }) {
  return (
    <button className={`wallet-button ${wallet.address ? 'connected' : ''}`} onClick={() => void (wallet.address ? wallet.disconnect() : wallet.connect())} disabled={wallet.connecting} title={wallet.address ? `${wallet.address} — click to disconnect` : 'Connect a Phantom-compatible wallet'}>
      <span className="status-dot" aria-hidden="true" />{wallet.connecting ? 'Connecting…' : wallet.address ? short(wallet.address) : 'Connect wallet'}
    </button>
  );
}

function Notice({ value }: { value: NoticeValue }) {
  return value ? <div className={`notice ${value.kind || 'info'}`} role={value.kind === 'error' ? 'alert' : 'status'}>{value.text}</div> : null;
}

function Address({ label, address }: { label: string; address?: string | null }) {
  return <div className="address-line"><span>{label}</span><code title={address || undefined}>{address || '—'}</code></div>;
}

function Balance({ label, amount, active }: { label: string; amount: string | null; active: boolean }) {
  return <div className={`balance ${active ? 'active' : ''}`}><span className="balance-label">{label}{active && <span className="custody-tag">Holds this payment</span>}</span><strong>{formatTokens(amount)} <small>test USDC</small></strong></div>;
}

function MoneyReceipt({ job, order, config, balances, chainTime, loading }: { job: Job | null; order?: Order | null; config: PublicConfig | null; balances: Balances; chainTime: number | null; loading: boolean }) {
  const state = job?.state;
  const unknown = !!order && chainTime === null;
  const custody = unknown ? 'Reading Solana' : state === 'Funded' ? 'Program vault' : state === 'Released' ? 'Merchant wallet' : 'Buyer wallet';
  const expiresAt = job?.expiresAt || order?.expiresAt;
  const [whole, fraction = '00'] = formatTokens(job?.amount || order?.amount || config?.amount || '5000000').split('.');
  return (
    <aside className="receipt" aria-label="Payment receipt">
      <div className="receipt-top"><span>Payment / 001</span><span>{config?.cluster || 'TEST NETWORK'}</span></div>
      <div className="receipt-amount"><span>$</span>{whole}<span className="receipt-decimal">.{fraction}</span></div>
      <p className="receipt-currency">MOCK USDC <span>6 DECIMALS</span></p>
      <div className="receipt-rule" />
      <div className="custody"><span>Where is this payment?</span><strong>{custody}</strong><p>{unknown ? 'Waiting for a finalized chain reading before confirming where this payment is held.' : state === 'Funded' ? 'Locked until you approve or the refund deadline arrives.' : state === 'Released' ? 'You approved. The recorded merchant received the deposit.' : state === 'Refunded' ? 'The deposit returned to the original buyer.' : 'The deposit stays with you until you sign the funding transaction.'}</p></div>
      <div className="balances" aria-label="Live finalized token balances">
        <Balance label="Buyer" amount={balances.buyer} active={!unknown && (!state || state === 'Refunded')} />
        <Balance label="Escrow vault" amount={balances.vault} active={state === 'Funded'} />
        <Balance label="Merchant" amount={balances.merchant} active={state === 'Released'} />
      </div>
      <div className="receipt-clock"><div><span>{state === 'Released' ? 'PAYMENT RELEASED' : state === 'Refunded' ? 'DEPOSIT REFUNDED' : expiresAt ? 'REFUND DEADLINE' : 'YOUR APPROVAL REQUIRED'}</span><strong>{state ? state === 'Funded' ? timeRemaining(expiresAt, chainTime) : 'Settled onchain' : expiresAt ? timeRemaining(expiresAt, chainTime) : 'You stay in control'}</strong></div><span className={`clock-dot ${loading ? 'reading' : ''}`} aria-hidden="true" /></div>
      <p className="receipt-small">Balances read directly from Solana at finalized commitment. Network fees are paid in SOL.</p>
      <div className="receipt-teeth" aria-hidden="true" />
    </aside>
  );
}

function Transactions({ config, records }: { config: PublicConfig | null; records: TxRecord[] }) {
  if (!config || !records.length) return null;
  return <section className="transaction-list" aria-label="Transactions"><h3>Transaction log</h3>{records.map((record) => <a key={record.signature} href={explorerUrl(config, record.signature)} target="_blank" rel="noreferrer"><span>{record.action}</span><code>{short(record.signature)}</code><span>View transaction ↗</span></a>)}</section>;
}

function ChainDetails({ config, job, order }: { config: PublicConfig | null; job: Job | null; order?: Order | null }) {
  if (!config) return null;
  return <details className="chain-details"><summary>Payment addresses &amp; deadline</summary><Address label="Program" address={config.programId} /><Address label="Mock USDC mint" address={job?.mint || order?.mint || config.mint} /><Address label="Buyer" address={job?.buyer || order?.buyer} /><Address label="Merchant" address={job?.merchant || order?.merchant || config.merchant} /><Address label="Job" address={job?.address || order?.jobAddress} /><Address label="Vault" address={job?.vault} />{(job?.expiresAt || order?.expiresAt) && <div className="address-line"><span>Chain deadline</span><time dateTime={new Date((job?.expiresAt || order!.expiresAt) * 1000).toISOString()}>{new Date((job?.expiresAt || order!.expiresAt) * 1000).toLocaleString()} · epoch {job?.expiresAt || order!.expiresAt}</time></div>}</details>;
}

function assertOrder(order: Order, config: PublicConfig, buyer: string, job?: Job | null) {
  if (order.buyer !== buyer) throw new Error('This quote belongs to another wallet. Reconnect the original buyer.');
  if (!/^[a-f0-9]{64}$/.test(order.jobId) || order.mint !== config.mint || order.merchant !== config.merchant || order.amount !== config.amount || !Number.isSafeInteger(order.expiresAt)) throw new Error('The merchant quote does not match this checkout configuration. Create a new quote.');
  if (deriveJobAddress(config, buyer, order.jobId).toString() !== order.jobAddress) throw new Error('The quoted job address does not match its buyer and job ID.');
  if (job && (job.address !== order.jobAddress || job.buyer !== buyer || job.mint !== order.mint || job.merchant !== order.merchant || job.amount !== order.amount || job.expiresAt !== order.expiresAt || job.jobId !== order.jobId)) throw new Error('The onchain purchase does not match the stored order. Do not approve it.');
}

function CheckoutPage({ wallet }: { wallet: Wallet }) {
  const [config, setConfig] = useState<PublicConfig | null>(baked.config);
  const [configError, setConfigError] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [history, setHistory] = useState<Order[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'normal' | 'stall'>('normal');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [records, setRecords] = useState<TxRecord[]>([]);
  const ledger = useLedger(config, order?.jobAddress || null, wallet.address);
  const state = ledger.job?.state;
  const expired = !!order && ledger.chainTime !== null && ledger.chainTime >= order.expiresAt;
  const originalBuyer = !!wallet.address && wallet.address === order?.buyer;
  const recoveryLink = order ? `/recover?job=${encodeURIComponent(order.jobAddress)}` : '/recover';

  useEffect(() => {
    let alive = true;
    request<unknown>('/api/config').then(validateConfig).then((value) => {
      if (!alive) return;
      if (!baked.config) {
        setConfig(null); setConfigError(baked.error); return;
      }
      const mismatch = (['programId', 'mint', 'merchant', 'cluster', 'rpcUrl'] as const).some((field) => value[field] !== baked.config![field]);
      if (mismatch) {
        setConfig(null);
        setConfigError('The merchant configuration differs from the compiled recovery client. Match the VITE public settings to the worker and rebuild before funding.');
        return;
      }
      setConfig(value); setConfigError(null);
    }).catch((error) => { if (alive) setConfigError(errorMessage(error)); });
    return () => { alive = false; };
  }, []);

  const remember = useCallback((value: Order) => {
    setOrder(value); persistOrder(value);
    setHistory((previous) => [value, ...previous.filter((item) => item.jobId !== value.jobId)].slice(0, 24));
  }, []);

  useEffect(() => {
    let alive = true;
    setOrder(null); setHistory([]); setNotice(null); setRecords([]);
    if (!wallet.address) return;
    const stored = savedOrders(wallet.address);
    setHistory(stored); setOrder(stored[0] || null);
    request<{ orders: Order[] }>(`/api/orders?buyer=${encodeURIComponent(wallet.address)}`).then(({ orders }) => {
      if (!alive) return;
      const sorted = orders.filter((item) => item.buyer === wallet.address).sort((a, b) => b.expiresAt - a.expiresAt);
      const selected = sorted.find((item) => item.jobId === stored[0]?.jobId) || sorted[0];
      setHistory(sorted); if (selected) remember(selected); setApiError(null);
    }).catch((error) => { if (alive) setApiError(errorMessage(error)); });
    return () => { alive = false; };
  }, [wallet.address, remember]);

  useEffect(() => {
    setPreviewLoaded(false);
    if (!order) return;
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const value = await request<Order>(`/api/orders/${order.jobId}`);
        if (alive) { remember(value); setApiError(null); }
      } catch (error) { if (alive) setApiError(errorMessage(error)); }
      finally { polling = false; }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 3000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [order?.jobId, remember]);

  const record = (action: string) => (signature: string) => setRecords((previous) => [{ action, signature }, ...previous]);

  async function action(label: string, work: () => Promise<void>) {
    setBusy(label); setNotice(null);
    try { await work(); }
    catch (error) { setNotice({ kind: 'error', text: errorMessage(error) }); }
    finally { setBusy(null); await ledger.refresh(); }
  }

  async function createQuote() {
    if (!wallet.address || !file || !config) return;
    await action('Saving PNG…', async () => {
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose a PNG no larger than 5 MB.');
      const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => signature[index] === byte)) throw new Error('This file is not a PNG. Choose a valid PNG image.');
      const data = new FormData(); data.append('buyer', wallet.address!); data.append('mode', mode); data.append('file', file);
      const value = await request<Order>('/api/orders', { method: 'POST', body: data });
      assertOrder(value, config!, wallet.address!); remember(value); setRecords([]);
      setNotice({ text: 'PNG saved. Your quote is ready; no funds have moved.' });
    });
  }

  async function fund() {
    if (!order || !config || !wallet.address || !ledger.connection) return;
    await action('Confirm deposit in wallet…', async () => {
      const existing = await fetchJob(ledger.connection!, config!, order.jobAddress);
      assertOrder(order, config!, wallet.address!, existing);
      if (existing && existing.state !== 'Funded') { await ledger.refresh(); return; }
      let signature: string | undefined;
      if (!existing) {
        if (await fetchChainTime(ledger.connection!) >= order.expiresAt) throw new Error('This quote expired before funding. Create a new quote.');
        const transaction = await buildFundTransaction(ledger.connection!, config!, { buyer: wallet.address!, jobId: order.jobId, expiresAt: order.expiresAt });
        signature = await sendTransaction(ledger.connection!, wallet.provider, wallet.address!, transaction, record('Deposit 5 test USDC'));
      }
      await ledger.refresh();
      remember(await post<Order>(`/api/orders/${order.jobId}/funded`, { signature }));
      setNotice({ kind: 'success', text: 'Deposit finalized. The program vault now holds 5 test USDC.' });
    });
  }

  async function approve() {
    if (!order || !config || !wallet.address || !ledger.connection || !previewLoaded) return;
    await action('Approve in wallet…', async () => {
      const current = await fetchJob(ledger.connection!, config!, order.jobAddress);
      assertOrder(order, config!, wallet.address!, current);
      if (!current || current.state !== 'Funded') throw new Error('This purchase is no longer awaiting approval. Refresh chain state.');
      if (await fetchChainTime(ledger.connection!) >= current.expiresAt) throw new Error('The approval deadline has passed. Open recovery to refund the deposit.');
      if (order.status !== 'ready') throw new Error('Wait until the persisted preview is ready.');
      const transaction = await buildApproveTransaction(ledger.connection!, config!, { buyer: wallet.address!, jobAddress: order.jobAddress });
      await sendTransaction(ledger.connection!, wallet.provider, wallet.address!, transaction, record('Release payment to merchant'));
      setNotice({ kind: 'success', text: 'Payment released. Sign a download challenge to get your original WebP.' });
      request<Order>(`/api/orders/${order.jobId}`).then(remember).catch(() => {});
    });
  }

  async function download() {
    if (!order || !wallet.address || !wallet.provider) return;
    await action('Confirm download ownership…', async () => {
      if (!wallet.provider!.signMessage) throw new Error('This wallet does not support message signing. Use a Phantom-compatible wallet to prove download ownership.');
      if (wallet.provider!.publicKey?.toString() !== order.buyer) throw new Error('Reconnect the original buyer wallet to unlock this file.');
      const challenge = await post<{ message: string; nonce: string; expiresAt: number }>(`/api/orders/${order.jobId}/challenge`, { buyer: wallet.address });
      const signed = await wallet.provider!.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
      const encoded = btoa(String.fromCharCode(...signed.signature));
      const response = await fetch(`${workerUrl}/api/orders/${order.jobId}/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buyer: wallet.address, nonce: challenge.nonce, signature: encoded }), cache: 'no-store' });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        throw new Error(data?.message || data?.error || `Download denied (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      if (!blob.type.startsWith('image/webp')) throw new Error('The merchant did not return a WebP. Try again while storage is available.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `holdfast-${order.jobId.slice(0, 10)}.webp`; document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setNotice({ kind: 'success', text: 'Your original WebP is downloaded. You can sign again after a reload while merchant storage is available.' });
    });
  }

  const previewReady = order && (order.status === 'ready' || order.status === 'released');
  const phase = state === 'Released' ? 4 : state === 'Refunded' ? 5 : state === 'Funded' ? previewReady ? 3 : 2 : order ? 1 : 0;

  return (
    <main id="main" className="main-wrap">
      <div className="eyebrow"><span className="line-marker" />Payment with a way back<span className="network-label">{config?.cluster || 'SOLANA'} / TEST MODE</span></div>
      <section className="hero"><h1>Good work.<br /><span>Then payment.</span></h1><p>Turn one PNG into a WebP.<br />{' '}Review the preview. Release the $5.<br />{' '}No approval? Your deposit has a way home.</p></section>
      <div className="checkout-grid">
        <div className="work-column">
          <div className="work-heading"><div><span className="section-kicker">The job</span><h2>PNG → WebP</h2></div><span className="job-tag">ONE FILE. ONE PAYMENT.</span></div>
          <Notice value={wallet.error ? { text: wallet.error, kind: 'error' } : null} />
          <Notice value={configError ? { text: `${configError}${config ? ' Using the compiled public chain configuration.' : ' Start the worker or configure apps/web/.env.'}`, kind: 'error' } : null} />
          <Notice value={notice} />
          {apiError && order && <Notice value={{ text: `Merchant API unavailable. Your payment state still comes from Solana. Open recovery if the deadline has passed. ${apiError}`, kind: 'error' }} />}
          {ledger.error && <Notice value={{ text: `Solana RPC: ${ledger.error}`, kind: 'error' }} />}
          {history.length > 0 && <div className="order-picker"><label htmlFor="saved-order">Saved purchases</label><select id="saved-order" value={order?.jobId || ''} onChange={(event) => { const selected = history.find((item) => item.jobId === event.target.value); if (selected) { remember(selected); setNotice(null); setRecords([]); } }}><option value="" disabled>New purchase</option>{history.map((item) => <option key={item.jobId} value={item.jobId}>{item.jobId.slice(0, 8)} · {item.status} · {item.mode === 'stall' ? 'stall rehearsal' : 'PNG conversion'}</option>)}</select></div>}
          {!order ? (
            <section className="upload-panel" aria-label="Upload and quote">
              <label className={`dropzone ${file ? 'has-file' : ''}`} htmlFor="png-file"><span className="file-glyph" aria-hidden="true">PNG</span><strong>{file ? file.name : 'Bring your PNG.'}</strong><span>{file ? `${(file.size / 1024).toFixed(0)} KB · click to replace` : 'Choose one image, up to 5 MB'}</span><input id="png-file" type="file" accept="image/png,.png" disabled={!!busy} onChange={(event) => { setFile(event.target.files?.[0] || null); setNotice(null); }} /></label>
              <fieldset className="mode-picker"><legend>Worker mode</legend><label className={mode === 'normal' ? 'selected' : ''}><input type="radio" name="mode" value="normal" checked={mode === 'normal'} onChange={() => setMode('normal')} /><span><strong>Normal delivery</strong><small>Convert, preview, approve.</small></span></label><label className={mode === 'stall' ? 'selected' : ''}><input type="radio" name="mode" value="stall" checked={mode === 'stall'} onChange={() => setMode('stall')} /><span><strong>Stall rehearsal</strong><small>Stop the work. Test the refund.</small></span></label></fieldset>
              {wallet.address ? <button className="button primary full" disabled={!file || !config || !!busy} onClick={() => void createQuote()}>{busy || 'Save PNG & get a quote'}<span aria-hidden="true">↗</span></button> : <button className="button primary full" onClick={() => void wallet.connect()} disabled={wallet.connecting}>{wallet.connecting ? 'Connecting…' : 'Connect wallet to begin'}<span aria-hidden="true">↗</span></button>}
              <p className="quiet-note">5 mock USDC per conversion. You sign before any tokens move.</p>
            </section>
          ) : (
            <section className="job-panel" aria-label="Current order">
              <div className="job-topline"><code>JOB {order.jobId.slice(0, 12)}</code><span className={`state-badge ${state === 'Released' || state === 'Refunded' ? 'settled' : ''}`}>{state || (expired ? 'Quote expired' : 'Quote ready')}</span></div>
              <ol className="timeline"><Step number="01" title="Deposit" detail="5 test USDC enters the program vault." done={phase > 1} active={phase === 1} /><Step number="02" title="Review" detail={order.mode === 'stall' ? 'Worker intentionally stalled for this rehearsal.' : 'A watermarked preview. Original safely persisted.'} done={phase >= 3 && phase !== 5} active={phase === 2 || phase === 3} /><Step number="03" title={state === 'Refunded' ? 'Refunded' : 'Approve & receive'} detail={state === 'Refunded' ? 'Your deposit is back with the original buyer.' : 'Your signature pays the merchant and unlocks the WebP.'} done={phase >= 4} active={phase === 4} /></ol>
              {previewReady && <figure className="preview"><div className="preview-checker"><img src={previewSource(order)} alt="Watermarked preview of your converted image" onLoad={() => setPreviewLoaded(true)} onError={() => { setPreviewLoaded(false); setNotice({ kind: 'error', text: 'The persisted preview could not be loaded. Check the merchant API before approving.' }); }} /></div><figcaption><span>Watermarked preview</span><span>Original unlocks after approval</span></figcaption></figure>}
              {state === 'Funded' && !previewReady && <div className={`processing-note ${order.mode === 'stall' ? 'stalled' : ''}`}><span className="processing-bar" /><strong>{order.mode === 'stall' ? 'The worker is deliberately stalled.' : order.status === 'failed' ? 'The conversion did not finish.' : 'Your file is being prepared.'}</strong><p>{order.error || (order.mode === 'stall' ? 'At the deadline, open the independent recovery page. It works even after the merchant API is stopped.' : 'Your 5 test USDC stays in escrow while you wait. You can refund at the chain deadline.')}</p></div>}
              {!state && !ledger.loading && <p className="job-explainer">{expired ? 'This unfunded quote has expired. Create a new quote to start again.' : 'Your PNG is saved. Sign one transaction to bind this buyer, merchant, mint, amount and deadline, and deposit into escrow.'}</p>}
              {state === 'Released' && <p className="job-explainer">The merchant received 5 test USDC. Prove you control the buyer wallet to download your original WebP. Signing a message does not move tokens.</p>}
              {state === 'Refunded' && <p className="job-explainer">5 test USDC returned to the recorded buyer. This purchase is settled and cannot be funded again.</p>}
              {!originalBuyer && <p className="inline-warning">Connect the original buyer wallet to act on this purchase.</p>}
              {!state && !expired && <button className="button primary full" disabled={!originalBuyer || !config || !!busy || ledger.chainTime === null || !!ledger.error} onClick={() => void fund()}>{busy || 'Deposit 5 test USDC'}<span aria-hidden="true">↗</span></button>}
              {state === 'Funded' && order.status === 'quoted' && !expired && <button className="button secondary full" disabled={!originalBuyer || !!busy} onClick={() => void fund()}>{busy || 'Resume verified worker'}</button>}
              {state === 'Funded' && previewReady && !expired && <button className="button primary full" disabled={!originalBuyer || order.status !== 'ready' || !previewLoaded || !!busy || !!ledger.error} onClick={() => void approve()}>{busy || 'Approve & release 5 test USDC'}<span aria-hidden="true">↗</span></button>}
              {state === 'Released' && <button className="button primary full" disabled={!originalBuyer || !!busy} onClick={() => void download()}>{busy || 'Sign & download original WebP'}<span aria-hidden="true">↗</span></button>}
              {state === 'Funded' && expired && <a className="button primary full" href={recoveryLink}>Refund 5 test USDC<span aria-hidden="true">↗</span></a>}
              <div className="job-links"><a href={recoveryLink}>Independent recovery ↗</a>{(state === 'Released' || state === 'Refunded' || (!state && expired)) && <button className="text-button" onClick={() => { setOrder(null); setFile(null); setNotice(null); setRecords([]); }}>Start another job</button>}</div>
              <ChainDetails config={config} job={ledger.job} order={order} />
            </section>
          )}
          <Transactions config={config} records={records} />
          <div className="trust-line"><span>YOU CONTROL THE RELEASE</span><p>The program enforces the payment. The merchant stores and delivers the file.</p></div>
        </div>
        <MoneyReceipt config={config} order={order} job={ledger.job} balances={ledger.balances} chainTime={ledger.chainTime} loading={ledger.loading} />
      </div>
    </main>
  );
}

function Step({ number, title, detail, done, active }: { number: string; title: string; detail: string; done: boolean; active: boolean }) {
  return <li className={`${done ? 'done' : ''} ${active ? 'active' : ''}`}><span className="step-number">{number}</span><div><strong>{title}</strong><p>{detail}</p></div><span className="step-status">{done ? 'DONE' : active ? 'CURRENT' : 'NEXT'}</span></li>;
}

function parseJobAddress(value: string): string {
  const input = value.trim();
  let address = input;
  if (input.includes('://') || input.startsWith('/')) {
    const url = new URL(input, window.location.origin);
    address = url.searchParams.get('job') || url.searchParams.get('address') || '';
  }
  try { return new PublicKey(address).toString(); }
  catch { throw new Error('Paste a valid Solana job address or a Holdfast recovery link containing ?job=.'); }
}

function RecoveryPage({ wallet }: { wallet: Wallet }) {
  // Keep this route independent: never call /api/config, /api/orders, or any merchant endpoint.
  const initial = useMemo(() => {
    const value = new URLSearchParams(window.location.search).get('job') || '';
    if (!value) return { address: null, value: '', error: null };
    try { return { address: parseJobAddress(value), value, error: null }; }
    catch (error) { return { address: null, value, error: errorMessage(error) }; }
  }, []);
  const [input, setInput] = useState(initial.value);
  const [address, setAddress] = useState<string | null>(initial.address);
  const [notice, setNotice] = useState<NoticeValue>(initial.error ? { text: initial.error, kind: 'error' } : null);
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<TxRecord[]>([]);
  const [lookedUp, setLookedUp] = useState(false);
  const ledger = useLedger(baked.config, address, wallet.address);
  const { job, chainTime } = ledger;
  const buyerMatches = !!job && job.buyer === wallet.address;
  const expired = !!job && chainTime !== null && chainTime >= job.expiresAt;

  useEffect(() => {
    if (!address) { setLookedUp(false); return; }
    if (ledger.loading) setLookedUp(true);
  }, [address, ledger.loading]);

  function inspect(event: FormEvent) {
    event.preventDefault();
    try {
      const value = parseJobAddress(input);
      setNotice(null); setAddress(value); setRecords([]); setLookedUp(false);
      window.history.replaceState(null, '', `/recover?job=${encodeURIComponent(value)}`);
      if (value === address) { setLookedUp(true); void ledger.refresh(); }
    } catch (error) { setNotice({ text: errorMessage(error), kind: 'error' }); }
  }

  async function refund() {
    if (!job || !baked.config || !ledger.connection || !wallet.address) return;
    setBusy(true); setNotice(null);
    try {
      const current = await fetchJob(ledger.connection, baked.config, job.address);
      if (!current || current.state !== 'Funded') throw new Error('This job has already settled or no longer exists. Refresh chain state.');
      if (current.buyer !== wallet.address) throw new Error('Only the original buyer can refund this deposit.');
      if (await fetchChainTime(ledger.connection) < current.expiresAt) throw new Error('The chain deadline has not arrived. Wait for the Solana clock.');
      const transaction = await buildRefundTransaction(ledger.connection, baked.config, { buyer: wallet.address, jobAddress: current.address });
      await sendTransaction(ledger.connection, wallet.provider, wallet.address, transaction, (signature) => setRecords((previous) => [{ action: 'Refund deposit to original buyer', signature }, ...previous]));
      setNotice({ kind: 'success', text: 'Refund finalized. The recorded deposit returned to the buyer wallet directly from the program vault.' });
    } catch (error) { setNotice({ text: errorMessage(error), kind: 'error' }); }
    finally { setBusy(false); await ledger.refresh(); }
  }

  return (
    <main id="main" className="main-wrap recovery-page">
      <div className="eyebrow"><span className="line-marker" />Independent recovery<span className="network-label">{baked.config?.cluster || 'SOLANA'} / DIRECT RPC</span></div>
      <section className="hero"><h1>Your deposit.<br /><span>Your way back.</span></h1><p>Merchant gone quiet?<br />{' '}Read your job straight from Solana.<br />{' '}Refund after its chain deadline.</p></section>
      <div className="checkout-grid">
        <section className="work-column">
          <div className="work-heading"><div><span className="section-kicker">No merchant connection required</span><h2>Recover from the vault</h2></div></div>
          <Notice value={baked.error ? { text: baked.error, kind: 'error' } : null} />
          <Notice value={wallet.error ? { text: wallet.error, kind: 'error' } : null} />
          <Notice value={notice} />
          {ledger.error && <Notice value={{ kind: 'error', text: `Solana RPC: ${ledger.error}` }} />}
          <form className="recovery-form" onSubmit={inspect}><label htmlFor="job-address">Job address or recovery link</label><div className="input-row"><input id="job-address" name="job" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Paste a job address or recovery link" autoComplete="off" spellCheck={false} required /><button className="button primary" type="submit" disabled={!baked.config || !input.trim() || busy}>Read job</button></div><p>Uses only the compiled program, mint and RPC settings. This page never contacts the merchant API.</p></form>
          {address && lookedUp && !ledger.loading && !ledger.error && !job && <Notice value={{ text: 'No Holdfast job exists at this address on the configured network. Check the job address, program and RPC.', kind: 'error' }} />}
          {job && <div className="job-panel recovery-job"><div className="job-topline"><code>JOB {job.jobId.slice(0, 12)}</code><span className={`state-badge ${job.state !== 'Funded' ? 'settled' : ''}`}>{job.state}</span></div><div className="recovery-summary"><span className="section-kicker">Recorded deposit</span><strong>{formatTokens(job.amount)} <small>test USDC</small></strong><p>{job.state === 'Refunded' ? 'This deposit has already returned to the buyer. The job record remains onchain.' : job.state === 'Released' ? 'The buyer approved this purchase. The merchant has received the payment.' : expired ? 'The deadline has arrived. The original buyer can now sign a refund.' : 'The deposit is still in escrow. Refund opens at the chain deadline.'}</p></div>{job.mint !== baked.config?.mint && <Notice value={{ kind: 'error', text: 'This job uses a mint different from the configured demo mint. Check this network configuration before acting.' }} />}{!wallet.address ? <button className="button primary full" onClick={() => void wallet.connect()} disabled={wallet.connecting}>{wallet.connecting ? 'Connecting…' : 'Connect buyer wallet'}</button> : !buyerMatches ? <Notice value={{ kind: 'error', text: `This wallet is not the buyer. Connect ${job.buyer} to refund this job.` }} /> : job.state === 'Funded' ? <button className="button primary full" onClick={() => void refund()} disabled={!expired || busy || !!ledger.error || job.mint !== baked.config?.mint}>{busy ? 'Confirm refund in wallet…' : expired ? `Refund ${formatTokens(job.amount)} test USDC` : `Refund opens in ${timeRemaining(job.expiresAt, chainTime)}`}<span aria-hidden="true">↗</span></button> : <div className="settlement-note">{job.state === 'Refunded' ? 'Refund complete. No merchant action was required.' : 'Payment settled. Return to checkout for a signed download while merchant storage is available.'}</div>}<div className="job-links"><button className="text-button" disabled={ledger.loading} onClick={() => void ledger.refresh()}>{ledger.loading ? 'Reading chain…' : 'Refresh chain state'}</button><a href="/">Return to checkout ↗</a></div><ChainDetails config={baked.config} job={job} /></div>}
          <Transactions config={baked.config} records={records} />
          <div className="trust-line"><span>BUYER INITIATED. PROGRAM ENFORCED.</span><p>The original buyer signs. The vault returns the recorded token amount to that buyer. The job stays settled.</p></div>
        </section>
        <MoneyReceipt config={baked.config} job={job} balances={ledger.balances} chainTime={chainTime} loading={ledger.loading} />
      </div>
    </main>
  );
}
