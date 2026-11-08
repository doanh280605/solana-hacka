import { WalletButton } from './components';
import { DemoPage, LandingPage } from './Marketing';
import { RecoveryPage } from './Recovery';
import { WorkspacePage } from './Workspace';
import { useWallet } from './wallet';

export function App() {
  const wallet = useWallet();
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const active = (route: string) => path === route ? 'current' : '';
  return <><a className="skip-link" href="#main">Skip to content</a><header className="site-header page-width"><a className="wordmark" href="/" aria-label="osid home">osid<span className="wordmark-period">.</span></a><span className="brand-description">A LITTLE MORE CONFIDENCE<br />IN YOUR NEXT LISTING.</span><nav aria-label="Main navigation"><a className={active('/demo')} href="/demo">The demo</a><a className={active('/app')} href="/app">Workspace</a><a className={active('/recover')} href="/recover">Recover funds</a></nav>{path === '/app' || path === '/recover' ? <WalletButton wallet={wallet} /> : <a className="header-action" href="/app">Open workspace</a>}</header>{path === '/' ? <LandingPage /> : path === '/demo' ? <DemoPage /> : path === '/app' ? <WorkspacePage wallet={wallet} /> : path === '/recover' ? <RecoveryPage wallet={wallet} /> : <main id="main" className="page-width missing-page"><span className="eyebrow">404</span><h1>Nothing on this shelf.</h1><a className="button primary" href="/">Back to osid</a></main>}<footer className="site-footer page-width"><a className="footer-brand" href="/">osid.</a><p>Approve the work. Then release the payment.</p><div><span>SOLANA TEST NETWORK · MOCK USDC</span><a href="/recover">Independent recovery</a></div></footer></>;
}
