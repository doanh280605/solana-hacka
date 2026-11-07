import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { PublicKey, buildRefundTransaction, fetchChainTime, fetchJob } from '@holdfast/chain';
import { savedOrders } from './api';
import { ChainDetails, DateTime, MoneyReceipt, Notice, type NoticeValue, type TxRecord, type Wallet } from './components';
import { compiledConfig, errorMessage } from './config';
import { formatTokens, timeRemaining, useLedger } from './ledger';
import { sendTransaction } from './wallet';

const baked = compiledConfig();
export function parseJobAddress(value: string): string {
  const input = value.trim();
  let address = input;
  if (input.includes('://') || input.startsWith('/')) {
    const url = new URL(input, window.location.origin);
    address = url.searchParams.get('job') || url.searchParams.get('address') || '';
  }
  try { return new PublicKey(address).toString(); }
  catch { throw new Error('Paste a Solana job address or a recovery link containing ?job=.'); }
}

export function RecoveryPage({ wallet }: { wallet: Wallet }) {
  // Deliberately no authentication hook, API configuration request or merchant metadata fetch.
  // savedOrders reads local browser metadata only; every authoritative field is read from Solana.
  const initial = useMemo(() => {
    const value = new URLSearchParams(window.location.search).get('job') || '';
    if (!value) return { address: null, value: '', error: null };
    try { return { address: parseJobAddress(value), value, error: null }; }
    catch (reason) { return { address: null, value, error: errorMessage(reason) }; }
  }, []);
  const [input, setInput] = useState(initial.value);
  const [address, setAddress] = useState<string | null>(initial.address);
  const [notice, setNotice] = useState<NoticeValue>(initial.error ? { text: initial.error, kind: 'error' } : null);
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<TxRecord[]>([]);
  const [lookedUp, setLookedUp] = useState(false);
  const ledger = useLedger(baked.config, address, wallet.address);
  const { job, chainTime } = ledger;
  const pending = job?.state === 'Funded' || job?.state === 'Submitted';
  const buyerMatches = !!job && job.buyer === wallet.address;
  const expired = !!job && chainTime !== null && chainTime >= job.expiresAt;
  const history = wallet.address ? savedOrders(wallet.address) : [];

  useEffect(() => { if (!address) setLookedUp(false); else if (ledger.loading) setLookedUp(true); }, [address, ledger.loading]);
  function inspect(event: FormEvent) {
    event.preventDefault();
    try {
      const value = parseJobAddress(input);
      setNotice(null); setAddress(value); setRecords([]); setLookedUp(false);
      window.history.replaceState(null, '', `/recover?job=${encodeURIComponent(value)}`);
      if (value === address) { setLookedUp(true); void ledger.refresh(); }
    } catch (reason) { setNotice({ text: errorMessage(reason), kind: 'error' }); }
  }
  async function refund() {
    if (!job || !baked.config || !ledger.connection || !wallet.address) return;
    setBusy(true); setNotice(null);
    try {
      const current = await fetchJob(ledger.connection, baked.config, job.address);
      if (!current || !['Funded', 'Submitted'].includes(current.state)) throw new Error('This job is already settled or no longer exists. Refresh its chain state.');
      if (current.buyer !== wallet.address) throw new Error('Only the original buyer can refund this deposit.');
      if (await fetchChainTime(ledger.connection) < current.expiresAt) throw new Error('The chain deadline has not arrived. Wait for the Solana clock.');
      const transaction = await buildRefundTransaction(ledger.connection, baked.config, { buyer: wallet.address, jobAddress: current.address });
      await sendTransaction(ledger.connection, wallet.provider, wallet.address, transaction, (signature) => setRecords((previous) => [{ action: 'Refund deposit to original buyer', signature }, ...previous]));
      setNotice({ kind: 'success', text: 'Refund finalized. The exact recorded amount returned directly from escrow to the original buyer. No merchant action or application session was required.' });
    } catch (reason) { setNotice({ text: errorMessage(reason), kind: 'error' }); }
    finally { setBusy(false); await ledger.refresh(); }
  }
  return <main id="main" className="page-width recovery-page"><div className="workspace-intro"><div><span className="eyebrow">INDEPENDENT RECOVERY / DIRECT SOLANA RPC</span><h1>Your deposit.<br /><em>Your way back.</em></h1></div><p>Merchant unavailable? Read the agreement from Solana.<br />At the deadline, the original buyer can sign a refund.<br />No application sign-in required.</p></div><div className="workspace-grid"><div className="work-column"><Notice value={baked.error ? { text: baked.error, kind: 'error' } : null} /><Notice value={wallet.error ? { text: wallet.error, kind: 'error' } : null} /><Notice value={notice} />{ledger.error && <Notice value={{ kind: 'error', text: `Solana RPC: ${ledger.error}` }} />}<section className="recovery-explainer"><span className="eyebrow">THE ESCROW HAS A CLOCK.</span><h2>The refund is yours to initiate.</h2><p>Refunds become available at the exact onchain deadline while a job is Funded or Submitted. They require a separate transaction signed by the recorded buyer. Released and Refunded jobs are final.</p></section><form className="recovery-form" onSubmit={inspect}><label htmlFor="job-address">Job address or recovery link</label><div className="input-row"><input id="job-address" name="job" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Paste your saved recovery link or Solana job address" autoComplete="off" spellCheck={false} required /><button className="button primary" type="submit" disabled={!baked.config || !input.trim() || busy}>Read job</button></div><p className="fine-print">This route makes zero merchant API requests. It uses compiled trusted configuration and Solana RPC, including for legacy V1 deposits.</p>{history.length > 0 && <div className="saved-recovery"><label htmlFor="saved-recovery">Or select a locally saved purchase</label><select id="saved-recovery" value={history.some((item) => item.jobAddress === address) ? address! : ''} onChange={(event) => { setInput(event.target.value); setAddress(event.target.value); setRecords([]); setNotice(null); setLookedUp(false); window.history.replaceState(null, '', `/recover?job=${encodeURIComponent(event.target.value)}`); }}><option value="" disabled>Select a purchase</option>{history.map((item) => <option key={item.jobAddress} value={item.jobAddress}>{item.version === 2 ? 'osid V2' : 'Legacy V1'} · {item.jobId.slice(0, 10)} · {item.status}</option>)}</select></div>}</form>{address && lookedUp && !ledger.loading && !ledger.error && !job && <Notice value={{ text: 'No supported job exists at this address on the configured network. Check the address, program and RPC.', kind: 'error' }} />}{job && <section className="recovery-job"><div className="order-heading"><div><span className="eyebrow">{job.version === 2 ? 'OSID / V2 AGREEMENT' : 'HISTORICAL V1 AGREEMENT'}</span><h2>{formatTokens(job.amount)} <small>mock USDC</small></h2></div><span className={`tag ${!pending ? 'positive' : ''}`}>{job.state}</span></div><p>{job.state === 'Refunded' ? 'This deposit has already returned to its buyer. The terminal job record remains onchain.' : job.state === 'Released' ? 'The buyer approved this result and the merchant received payment. This order is final.' : expired ? 'The deadline has arrived. The recorded buyer can now sign a refund.' : 'Your deposit is held in the program vault. Refund access opens at the recorded deadline.'}</p><div className="refund-deadline"><span className="label">REFUND AVAILABLE AT</span><strong><DateTime seconds={job.expiresAt} /></strong>{pending && !expired && <span>{timeRemaining(job.expiresAt, chainTime)} remaining by the finalized chain clock</span>}</div>{job.mint !== baked.config?.mint && <Notice value={{ kind: 'error', text: 'This job uses a different mint from the configured demo mint. Verify the network and addresses before acting.' }} />}{!wallet.address ? <button className="button primary full" onClick={() => void wallet.connect()} disabled={wallet.connecting}>{wallet.connecting ? 'Connecting…' : 'Connect buyer wallet'}</button> : !buyerMatches ? <Notice value={{ kind: 'error', text: `This wallet is not the original buyer. Connect ${job.buyer} to refund this job.` }} /> : pending ? <button className="button primary full" onClick={() => void refund()} disabled={!expired || busy || !!ledger.error || job.mint !== baked.config?.mint}>{busy ? 'Confirm refund in wallet…' : expired ? `Refund ${formatTokens(job.amount)} mock USDC` : `Refund opens in ${timeRemaining(job.expiresAt, chainTime)}`}</button> : <div className="settlement-note">{job.state === 'Refunded' ? 'Refund complete. No merchant action was required.' : 'Payment released. Return to your workspace for a private download while merchant storage is available.'}</div>}<div className="order-links"><button className="text-button" disabled={ledger.loading} onClick={() => void ledger.refresh()}>{ledger.loading ? 'Reading chain…' : 'Refresh chain state'}</button><a className="inline-link" href="/app">Return to workspace</a></div><ChainDetails config={baked.config} job={job} records={records} /></section>}<div className="recovery-trust"><span className="eyebrow">BUYER AUTHORIZED. PROGRAM ENFORCED.</span><p>The provider cannot sign for you. The refund returns the recorded token amount to your canonical token account. Network fees are separate.</p></div></div><MoneyReceipt config={baked.config} job={job} balances={ledger.balances} chainTime={chainTime} loading={ledger.loading} error={ledger.error} /></div></main>;
}
