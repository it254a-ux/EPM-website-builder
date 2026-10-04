import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Blocks,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleHelp,
  CircleDollarSign,
  CreditCard,
  Eye,
  EyeOff,
  Globe2,
  Layers3,
  LayoutDashboard,
  LifeBuoy,
  LogIn,
  Menu,
  Palette,
  Play,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import type * as React from 'react';
import {
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';

type Profile = {
  name: string;
  email: string;
};

type SiteDraft = {
  name: string;
  title: string;
  domain: string;
  primaryColor: string;
};

type BrandStyle = CSSProperties & { '--brand-accent': string };

const profileKey = 'emt-demo-profile';
const draftKey = 'emt-demo-site:';
const defaultSite: SiteDraft = {
  name: '',
  title: '',
  domain: '',
  primaryColor: '#20b7dc',
};

function readProfile(): Profile | null {
  try {
    const value = localStorage.getItem(profileKey);
    return value ? (JSON.parse(value) as Profile) : null;
  } catch {
    return null;
  }
}

function siteKey(email: string) {
  return `${draftKey}${email.trim().toLowerCase()}`;
}

function siteSlug(name: string) {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug) return slug;
  // Names with no Latin letters (e.g. Arabic, Chinese) still get a stable, working address.
  let hash = 0;
  for (const char of name.trim()) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return name.trim() ? `site-${hash.toString(36)}` : '';
}

function brandStyle(color: string): BrandStyle {
  return { '--brand-accent': color };
}

function readSite(email: string): SiteDraft {
  try {
    const value = localStorage.getItem(siteKey(email));
    return value ? { ...defaultSite, ...JSON.parse(value) } : defaultSite;
  } catch {
    return defaultSite;
  }
}

function findPublicSite(slug: string): SiteDraft | null {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(draftKey)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const site = { ...defaultSite, ...JSON.parse(raw) } as SiteDraft;
      if (site.name && siteSlug(site.name) === slug) return site;
    }
  } catch {
    return null;
  }
  return null;
}

function App() {
  const [profile, setProfile] = useState<Profile | null>(readProfile);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  function signOut() {
    localStorage.removeItem(profileKey);
    setProfile(null);
    navigate('/');
  }

  return (
    <div className="app-frame">
      <Routes>
        <Route
          element={
            <MarketingLayout profile={profile} onSignOut={signOut} />
          }
        >
          <Route index element={<HomePage />} />
          <Route path="how-it-works" element={<HowItWorksPage />} />
          <Route path="features" element={<FeaturesPage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="contact" element={<ContactPage />} />
          <Route path="signup" element={<ExternalRedirect to={OWNER_URL} />} />
          <Route path="login" element={<ExternalRedirect to={OWNER_URL} />} />
          <Route path="privacy" element={<LegalPage kind="privacy" />} />
          <Route path="terms" element={<LegalPage kind="terms" />} />
        </Route>
        <Route
          path="/dashboard/*"
          element={
            <Dashboard
              profile={profile}
              onSignOut={signOut}
              onProfileChange={setProfile}
            />
          }
        />
        <Route path="/p/:siteSlug" element={<PublicTradingSite />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  );
}

function MarketingLayout({
  profile,
  onSignOut,
}: {
  profile: Profile | null;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <>
      <header className="site-header">
        <nav className="nav-pill" aria-label="Main navigation">
          <Link to="/" className="brand" aria-label="EPM home">
            <span className="brand-mark">
              <CircleDollarSign size={23} strokeWidth={2.2} />
            </span>
            <span>EPM</span>
          </Link>
          <button
            className="mobile-menu-button"
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? 'Close navigation' : 'Open navigation'}
            aria-expanded={open}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className={`nav-links${open ? ' nav-links-open' : ''}`}>
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/how-it-works">How It Works</NavLink>
            <NavLink to="/features">Features</NavLink>
            <NavLink to="/about">About</NavLink>
            <NavLink to="/contact">Contact</NavLink>
            <span className="nav-mobile-account">
              <AccountLinks profile={profile} onSignOut={onSignOut} />
            </span>
          </div>
          <span className="nav-desktop-account">
            <AccountLinks profile={profile} onSignOut={onSignOut} />
          </span>
        </nav>
      </header>
      <main className="marketing-main">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

function AccountLinks({
  profile,
  onSignOut,
}: {
  profile: Profile | null;
  onSignOut: () => void;
}) {
  if (profile) {
    return (
      <>
        <Link to="/dashboard"><LayoutDashboard size={15} /> Dashboard</Link>
        <button className="signout-link" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </>
    );
  }
  return (
    <>
      <a className="signin-link" href={OWNER_URL}><LogIn size={15} /> Sign In</a>
      <a className="button button-gradient nav-get-started" href={OWNER_URL}>
        <Users size={15} /> Get Started
      </a>
    </>
  );
}

function PageWrap({
  eyebrow,
  title,
  intro,
  children,
  className = '',
}: {
  eyebrow?: string;
  title: string;
  intro?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`page-wrap ${className}`}>
      <div className="page-heading">
        {eyebrow && <p className="eyebrow"><span />{eyebrow}</p>}
        <h1>{title}</h1>
        {intro && <p className="page-intro">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

const OWNER_URL = 'https://executiveprimemarkets.site/owner';
const WHATSAPP_NUMBER = '254705491022';

function ExternalRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return (
    <PageWrap title="Taking you to your account" intro="One moment while we open the secure sign-in page.">
      <a className="button button-gradient" href={to}>Continue <ArrowRight size={16} /></a>
    </PageWrap>
  );
}

function HomePage() {
  return (
    <>
      <section className="hero section-grid">
        <div className="hero-copy">
          <p className="eyebrow"><span /> WHITE-LABEL DERIV PLATFORM</p>
          <h1>Your own Deriv trading platform, <span>under your brand.</span></h1>
          <p className="hero-description">
            Launch a branded trading site in minutes. Choose your name, logo and
            colours, give your clients the complete Deriv bot builder and analysis
            tools, and keep up to 85% of the commission your platform generates.
          </p>
          <div className="hero-actions">
            <a className="button button-gradient button-large" href={OWNER_URL}>
              Create your platform <ArrowRight size={18} />
            </a>
            <Link className="text-link" to="/how-it-works">
              See how it works <ArrowRight size={16} />
            </Link>
          </div>
          <div className="trust-note">
            <ShieldCheck size={17} />
            Free to start · No coding required · Live the moment you create your site
          </div>
        </div>
        <PlatformPreview />
      </section>
      <Stats />
      <section className="home-value section-grid">
        <div>
          <p className="eyebrow"><span /> WHY EPM</p>
          <h2>A complete trading brand, without building the technology.</h2>
          <p>
            EPM supplies the infrastructure: Deriv sign-in, a visual bot builder,
            market analysis tools and a ready-made strategy library. You bring the
            brand and the audience, and manage your platform from one dashboard.
          </p>
          <Link className="button button-dark" to="/how-it-works">
            Explore the process <ArrowRight size={17} />
          </Link>
        </div>
        <div className="value-card-list">
          <ValueCard icon={<Palette />} title="Your identity, front and centre" detail="Your name, logo, colours and typeface, plus your own About, Vision and Mission pages." />
          <ValueCard icon={<Blocks />} title="Professional tools included" detail="Bot builder, analysis tool and a free strategy library, all maintained by EPM." />
          <ValueCard icon={<BarChart3 />} title="Clear, agreed earnings" detail="A fixed commission split set in advance and paid out monthly." />
        </div>
      </section>
      <section className="bottom-cta">
        <div>
          <p className="eyebrow"><span /> READY TO START</p>
          <h2>Put your name on your own trading platform.</h2>
        </div>
        <a className="button button-gradient button-large" href={OWNER_URL}>
          Get started <ArrowRight size={18} />
        </a>
      </section>
    </>
  );
}

function PlatformPreview() {
  return (
    <div className="preview-stage">
      <div className="preview-orbit orbit-one" />
      <div className="preview-orbit orbit-two" />
      <div className="preview-window">
        <div className="window-chrome">
          <div className="window-dots"><i /><i /><i /></div>
          <span>yourbrand.com / preview</span>
          <div className="window-lock">●</div>
        </div>
        <div className="preview-app">
          <aside className="preview-sidebar">
            <div className="preview-logo"><span className="brand-mark mini-mark">E</span> Your Brand</div>
            <div className="sidebar-active"><LayoutDashboard size={13} /> Overview</div>
            <div><Layers3 size={13} /> Sites</div>
            <div><Globe2 size={13} /> Domains</div>
            <div><Rocket size={13} /> Deployments</div>
            <div><Wallet size={13} /> Commissions</div>
            <div><Bot size={13} /> Trading bots</div>
          </aside>
          <div className="preview-content">
            <div className="preview-greeting"><span>ILLUSTRATIVE WORKSPACE</span><b>Your platform at a glance</b></div>
            <div className="preview-kpis">
              <div><span>Site setup</span><b>Preview</b></div>
              <div><span>Commission activity</span><b>—</b><small>Appears once your platform is live</small></div>
            </div>
            <div className="preview-chart-head"><b>Platform activity</b><span>Last 7 days⌄</span></div>
            <div className="preview-chart">
              <div className="chart-grid-lines" />
              <svg viewBox="0 0 450 138" preserveAspectRatio="none" aria-label="Illustrative trading platform activity chart">
                <defs><linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c9a24b" stopOpacity=".25" /><stop offset="1" stopColor="#c9a24b" stopOpacity="0" /></linearGradient></defs>
                <path d="M0 108 C34 97 38 112 66 92 S105 103 137 77 S168 83 196 62 S231 81 264 47 S297 66 325 38 S370 55 402 20 S425 31 450 10 L450 138 L0 138 Z" fill="url(#area-fill)" />
                <path d="M0 108 C34 97 38 112 66 92 S105 103 137 77 S168 83 196 62 S231 81 264 47 S297 66 325 38 S370 55 402 20 S425 31 450 10" fill="none" stroke="#a9792a" strokeWidth="3" />
              </svg>
              <div className="chart-labels"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
            </div>
          </div>
        </div>
      </div>
      <div className="floating-card earnings-float"><span><TrendingUp size={16} /></span><div><small>Settlement schedule</small><b>Monthly · preview</b></div><ArrowRight size={16} /></div>
      <div className="floating-card live-float"><i className="status-dot" /> Illustrative preview</div>
    </div>
  );
}

function Stats() {
  return (
    <section className="stats-band">
      <div className="stats-inner">
        <div><b>75%</b><span>Your share on a free address</span></div>
        <div><b>85%</b><span>Your share on your own domain</span></div>
        <div><b>Instant</b><span>Free sites go live on creation</span></div>
      </div>
    </section>
  );
}

function ValueCard({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <article className="value-card"><span className="icon-box">{icon}</span><div><h3>{title}</h3><p>{detail}</p></div><ArrowRight size={17} className="value-arrow" /></article>;
}

const steps = [
  { number: '01', icon: <Layers3 />, title: 'Create your account', text: 'Sign up and choose how to launch: a free address on our domain, or your own domain such as trade.yourbrand.com.' },
  { number: '02', icon: <Palette />, title: 'Brand your platform', text: 'Add your name, logo, colours and typeface, and write your About, Vision and Mission. Own-domain sites also add their own support contacts.' },
  { number: '03', icon: <Rocket />, title: 'Go live', text: 'Free sites go live the moment you create them. Own-domain sites are reviewed, connected and activated by our team.' },
  { number: '04', icon: <BarChart3 />, title: 'Earn commission', text: 'Commission from your clients’ trading activity accrues through the month. Once Deriv’s monthly partner payment is received and reconciled, your agreed share is paid out.' },
];

function HowItWorksPage() {
  return (
    <PageWrap eyebrow="FROM SIGN-UP TO LIVE" title="How it works" intro="Four steps take you from sign-up to a live, branded platform. Commission accrues monthly and is paid out once Deriv’s partner payment has been received." className="how-page">
      <div className="steps-grid">
        {steps.map((step) => (
          <article className="step-card" key={step.number}>
            <div className="step-top"><span className="step-icon">{step.icon}</span><span className="step-number">STEP {step.number}</span></div>
            <h2>{step.title}</h2><p>{step.text}</p>
            <span className="step-watermark">{step.number}</span>
          </article>
        ))}
      </div>
      <section className="plans-section">
        <div className="values-heading"><p className="eyebrow">CHOOSE YOUR LAUNCH</p><h2>Two ways to go live</h2></div>
        <div className="plans-grid">
          <article className="feature-card">
            <div className="feature-card-top"><span className="icon-box"><Rocket /></span><span className="feature-index">75%</span></div>
            <p className="feature-tag">START HERE</p><h2>Free address</h2>
            <p>Live instantly at yourname.executiveprimemarkets.site. Full branding and the complete toolset, with customer support handled by EPM. You keep 75% of commission; EPM keeps 25%.</p>
          </article>
          <article className="feature-card">
            <div className="feature-card-top"><span className="icon-box"><Globe2 /></span><span className="feature-index">85%</span></div>
            <p className="feature-tag">FULL OWNERSHIP</p><h2>Your own domain</h2>
            <p>Run on your own address, with your own WhatsApp, phone and email for client support. Reviewed and activated by our team. You keep 85% of commission; EPM keeps 15%.</p>
          </article>
        </div>
      </section>
      <CtaStrip title="Your platform is one sign-up away." />
    </PageWrap>
  );
}

const features = [
  { icon: <Palette />, title: 'Complete branding', text: 'Your name, logo, colours and typeface across the whole platform, with your own About, Vision and Mission pages.', tag: 'YOUR BRAND' },
  { icon: <Bot />, title: 'Visual bot builder', text: 'A drag-and-drop builder for Deriv trading bots, with stop-loss, take-profit and flexible trade logic.', tag: 'BUILD STRATEGIES' },
  { icon: <BarChart3 />, title: 'Market analysis', text: 'An analysis tool that tracks live market data and digit statistics so clients can study conditions before they trade. It informs decisions; it does not predict outcomes.', tag: 'MARKET INSIGHTS' },
  { icon: <Blocks />, title: 'Strategy library', text: 'A growing library of ready-made bots your clients can browse and load in a click, managed centrally by EPM.', tag: 'START FASTER' },
  { icon: <Wallet />, title: 'Transparent commission', text: 'A fixed split agreed in advance: 75% to you on a free address, 85% on your own domain, paid out monthly.', tag: 'CLEAR TERMS' },
  { icon: <Globe2 />, title: 'Your own domain', text: 'Move to your own address whenever you are ready. We tell you the exact DNS record to add and activate the site after review.', tag: 'YOUR ADDRESS' },
];

function FeaturesPage() {
  return (
    <PageWrap eyebrow="CAPABILITIES" title="Everything you need to launch" intro="A complete toolkit for branding, launching and running your own Deriv-powered trading platform." className="features-page">
      <div className="features-grid">
        {features.map((feature, index) => (
          <article className="feature-card" key={feature.title}>
            <div className="feature-card-top"><span className="icon-box">{feature.icon}</span><span className="feature-index">0{index + 1}</span></div>
            <p className="feature-tag">{feature.tag}</p><h2>{feature.title}</h2><p>{feature.text}</p>
            <span className="feature-decoration">{feature.icon}</span>
          </article>
        ))}
      </div>
      <CtaStrip title="Launch your own branded platform today." />
    </PageWrap>
  );
}

function AboutPage() {
  return (
    <PageWrap eyebrow="ABOUT EPM" title="Trading technology, packaged for platform owners." intro="Executive Prime Markets gives entrepreneurs and communities a ready-built way to run their own Deriv-powered trading platform." className="about-page">
      <section className="mission-layout">
        <div className="mission-copy"><span className="icon-box"><Rocket /></span><p className="eyebrow">OUR MISSION</p><h2>Make owning a trading platform straightforward.</h2><p>Building trading software from scratch takes a team and a budget. EPM removes that barrier: you launch under your own brand on infrastructure that already works, and focus on serving your clients.</p><p>Branding controls, a visual bot builder, market analysis tools, a strategy library and transparent commission terms are all part of the platform.</p></div>
        <div className="mission-stat"><span className="icon-box"><Users /></span><b>85%</b><span>Your share on your own domain</span><div className="stat-progress"><i /></div><small>Commission split</small></div>
      </section>
      <div className="values-heading"><p className="eyebrow">OUR PRINCIPLES</p><h2>The principles we work by</h2></div>
      <div className="values-grid">
        <ValueCard icon={<ShieldCheck />} title="Transparency" detail="Commission rates are agreed up front and stated plainly, so you always know how your share is calculated." />
        <ValueCard icon={<Sparkles />} title="Continuous improvement" detail="We keep refining the platform and adding tools that make running a trading brand easier." />
        <ValueCard icon={<Users />} title="Support" detail="Clients of free sites are supported directly by EPM, and own-domain owners are guided through setup." />
      </div>
      <CtaStrip title="Build a trading brand of your own." />
    </PageWrap>
  );
}

const faqs = [
  { question: 'How is commission shared?', answer: 'Commission earned on your clients’ eligible trading activity is split between EPM and you. On a free address, EPM keeps 25% and you receive 75%. On your own domain, EPM keeps 15% and you receive 85%. For example, on a $10 commission pool with your own domain, that is $8.50 for you and $1.50 for EPM. Final terms are set out in your agreement.' },
  { question: 'When and how do I get paid?', answer: 'Commission accrues through the month. After Deriv’s monthly partner payment is received and reconciled by EPM, your share is paid out. Payout methods and timing are confirmed in your agreement.' },
  { question: 'How long does it take to launch?', answer: 'A free address goes live the moment you create it. An own-domain site is reviewed and activated by our team once the DNS record for your domain is in place.' },
  { question: 'Can I use my own domain?', answer: 'Yes. Choose your own domain when you sign up, or request it later from your dashboard. We will tell you exactly which DNS record to add.' },
  { question: 'Is trading risky?', answer: 'Yes. Trading on Deriv, including synthetic indices and digital options, carries a high risk of loss, and past results do not predict future ones. Commission depends on client trading activity and is not guaranteed.' },
];

function ContactPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [sent, setSent] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const message = String(form.get('message') ?? '').trim();
    const text = `Hello EPM, my name is ${name}. ${message}`;
    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
    setSent(true);
  }

  return (
    <PageWrap eyebrow="SUPPORT" title="Get in touch" intro="Questions before you start? Message our team and we will reply as soon as we can." className="contact-page">
      <div className="contact-layout">
        <form className="contact-form panel" onSubmit={submit}>
          <h2>Send us a message</h2>
          {sent && <div className="inline-success"><Check size={16} /> Opening WhatsApp with your message.</div>}
          <label>Your name<input required name="name" autoComplete="name" placeholder="Your full name" /></label>
          <label>Message<textarea required name="message" rows={5} placeholder="How can we help?" /></label>
          <button className="button button-gradient button-full" type="submit">Message us on WhatsApp <ArrowRight size={16} /></button>
        </form>
        <div className="contact-side">
          <article className="whatsapp-card"><span className="icon-box"><LifeBuoy /></span><p className="eyebrow">DIRECT SUPPORT</p><h2>Prefer a quick chat?</h2><p>Our team is available on WhatsApp.</p><strong>+254 705 491 022</strong><a href={`https://wa.me/${WHATSAPP_NUMBER}`} target="_blank" rel="noreferrer">Open WhatsApp <ArrowUpRight size={15} /></a></article>
          <section className="faq-panel"><p className="eyebrow">FAQ</p><h2>Common questions</h2>{faqs.map((faq, index) => <div className={`faq-item${openFaq === index ? ' faq-open' : ''}`} key={faq.question}><button type="button" onClick={() => setOpenFaq(openFaq === index ? null : index)}>{faq.question}<ChevronDown size={17} /></button>{openFaq === index && <p>{faq.answer}</p>}</div>)}</section>
        </div>
      </div>
    </PageWrap>
  );
}

function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const title = kind === 'privacy' ? 'Privacy Policy' : 'Terms of Service';
  return (
    <PageWrap eyebrow="LEGAL" title={title} intro="Our full legal documents are being finalised." className="legal-page">
      <section className="panel legal-notice">
        <span className="icon-box"><ShieldCheck /></span>
        <h2>Publication in progress</h2>
        <p>
          The Privacy Policy and Terms of Service will cover how account data,
          trading activity, referrals and commission settlements are handled.
          If you have questions in the meantime, please contact the team.
        </p>
        <Link className="text-action" to="/contact">
          Contact the team <ArrowRight size={15} />
        </Link>
      </section>
    </PageWrap>
  );
}

function AuthPage({
  mode,
  onAuthenticated,
}: {
  mode: 'login' | 'signup';
  onAuthenticated: (profile: Profile) => void;
}) {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const isSignup = mode === 'signup';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const name = String(form.get('name') ?? '').trim();

    if (isSignup && password !== String(form.get('confirmPassword') ?? '')) {
      setError('Your passwords do not match.');
      return;
    }
    const profile = isSignup
      ? { name, email }
      : readProfile();
    if (!profile || (!isSignup && profile.email.toLowerCase() !== email.toLowerCase())) {
      setError('No demo account found for that email. Create a demo account first.');
      return;
    }
    if (password.length < 6) {
      setError('Use a password with at least 6 characters.');
      return;
    }
    localStorage.setItem(profileKey, JSON.stringify(profile));
    onAuthenticated(profile);
    navigate('/dashboard');
  }

  return (
    <div className="auth-layout">
      <div className="auth-promo">
        <p className="eyebrow"><span /> YOUR NEXT CHAPTER STARTS HERE</p>
        <h1>{isSignup ? 'Build a trading brand that’s yours.' : 'Good to have you back.'}</h1>
        <p>{isSignup ? 'Create your account and follow a guided journey from first idea to your own branded platform.' : 'Pick up where you left off and keep moving your platform forward.'}</p>
        <div className="auth-promo-points"><span><Check size={16} /> A guided platform setup</span><span><Check size={16} /> Your brand, your way</span><span><Check size={16} /> One owner workspace</span></div>
        <PlatformPreview />
      </div>
      <form className="auth-form panel" onSubmit={submit}>
        <Link className="auth-back" to="/"><ChevronLeft size={16} /> Back to EPM</Link>
        <span className="icon-box auth-form-icon">{isSignup ? <Users /> : <LogIn />}</span>
        <p className="eyebrow">{isSignup ? 'JOIN THE NETWORK' : 'WELCOME BACK'}</p>
        <h2>{isSignup ? 'Create account' : 'Sign in'}</h2>
        <p className="auth-form-intro">{isSignup ? 'Start building your platform today.' : 'Sign in to manage your platform.'}</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        {isSignup && <label>Full name<input required name="name" autoComplete="name" placeholder="Your full name" /></label>}
        <label>Email<input required name="email" type="email" autoComplete="email" placeholder="you@example.com" /></label>
        <label>Password<span className="password-input"><input required name="password" type={showPassword ? 'text' : 'password'} autoComplete={isSignup ? 'new-password' : 'current-password'} placeholder="At least 6 characters" minLength={6} /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)}>        {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
        {isSignup && <><label>Confirm password<input required name="confirmPassword" type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="Re-enter your password" minLength={6} /></label><label className="checkbox-row"><input required type="checkbox" /> <span>I agree to the <Link to="/privacy">Privacy Policy</Link> and <Link to="/terms">Terms of Service</Link>.</span></label></>}
        <div className="demo-warning"><ShieldCheck size={15} /> Demo only. Your account is saved in this browser and isn’t securely authenticated.</div>
        <button className="button button-gradient button-full" type="submit">{isSignup ? 'Create account' : 'Sign in'} <ArrowRight size={16} /></button>
        <p className="auth-switch">{isSignup ? 'Already have an account?' : 'New to EPM?'} <Link to={isSignup ? '/login' : '/signup'}>{isSignup ? 'Sign in' : 'Create an account'}</Link></p>
      </form>
    </div>
  );
}

function Dashboard({
  profile,
  onSignOut,
  onProfileChange,
}: {
  profile: Profile | null;
  onSignOut: () => void;
  onProfileChange: (profile: Profile) => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [site, setSite] = useState<SiteDraft>(() =>
    profile ? readSite(profile.email) : defaultSite,
  );
  const [saved, setSaved] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [step, setStep] = useState(1);

  useEffect(() => {
    if (!profile) navigate('/signup', { replace: true });
  }, [profile, navigate]);

  if (!profile) return null;
  const ownerEmail = profile.email;

  function updateSite(key: keyof SiteDraft, value: string) {
    setSite((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  function saveSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    localStorage.setItem(siteKey(ownerEmail), JSON.stringify(site));
    setSaved(true);
  }

  const navItems: { label: string; icon: ReactNode; to: string; count?: string }[] = [
    { label: 'Overview', icon: <LayoutDashboard size={17} />, to: '/dashboard' },
    { label: 'Sites', icon: <Layers3 size={17} />, to: '/dashboard/sites', count: site.name ? '1' : '0' },
    { label: 'Domains', icon: <Globe2 size={17} />, to: '/dashboard/domains' },
    { label: 'Deployments', icon: <Rocket size={17} />, to: '/dashboard/deployments' },
    { label: 'Commissions', icon: <Wallet size={17} />, to: '/dashboard/commissions' },
    { label: 'Trading bots', icon: <Bot size={17} />, to: '/dashboard/bots' },
    { label: 'Strategies', icon: <Blocks size={17} />, to: '/dashboard/strategies' },
    { label: 'Support', icon: <CircleHelp size={17} />, to: '/dashboard/support' },
    { label: 'Settings', icon: <Palette size={17} />, to: '/dashboard/settings' },
  ];

  return (
    <div className="dashboard-shell">
      <aside className={`dashboard-sidebar${menuOpen ? ' sidebar-open' : ''}`}>
        <Link className="brand dashboard-brand" to="/"><span className="brand-mark"><CircleDollarSign size={23} strokeWidth={2.2} /></span><span>EPM</span></Link>
        <div className="workspace-switch"><span className="workspace-avatar">{(site.name || profile.name).slice(0, 1).toUpperCase()}</span><span><b>{site.name || 'Your workspace'}</b><small>Site owner</small></span><ChevronDown size={15} /></div>
        <p className="sidebar-label">WORKSPACE</p>
        <div className="dashboard-nav">{navItems.map((item) => <NavLink key={item.label} to={item.to} end={item.to === '/dashboard'} onClick={() => setMenuOpen(false)}>{item.icon}<span>{item.label}</span>{item.count !== undefined && <span className="nav-count">{item.count}</span>}</NavLink>)}</div>
        <div className="sidebar-spacer" />
        <div className="sidebar-help"><span className="icon-box"><LifeBuoy size={17} /></span><b>Need a hand?</b><p>Visit our help center or talk to our team.</p><Link to="/contact">Get support <ArrowRight size={14} /></Link></div>
        <button className="sidebar-user" type="button" onClick={onSignOut}><span className="user-avatar">{profile.name.slice(0, 1).toUpperCase()}</span><span><b>{profile.name}</b><small>{profile.email}</small></span><LogIn size={16} /></button>
      </aside>
      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <button className="mobile-menu-button dashboard-menu" type="button" onClick={() => setMenuOpen((value) => !value)} aria-label="Toggle dashboard menu"><Menu size={19} /></button>
          <span>Workspace <ChevronDown size={14} /> <i>/</i> {sectionTitle(pathname)}</span>
          <div><span className="dashboard-live"><i className="status-dot" /> Preview mode</span><button className="dashboard-avatar" type="button" onClick={onSignOut} title="Sign out">{profile.name.slice(0, 1).toUpperCase()}</button></div>
        </header>
        <div className="dashboard-content">
          <Routes>
            <Route index element={<Overview profile={profile} site={site} />} />
            <Route path="sites" element={<SitesPage site={site} onCreate={() => { setStep(1); navigate('/dashboard/sites/new'); }} />} />
            <Route path="sites/new" element={<SiteWizard site={site} updateSite={updateSite} saveSite={saveSite} saved={saved} step={step} setStep={setStep} />} />
            <Route path="domains" element={<PlaceholderWorkspace icon={<Globe2 />} title="Domains" text="Connect a custom domain to make your platform easy to find." action="Add a domain" onAction={() => navigate('/dashboard/sites/new')} />} />
            <Route path="deployments" element={<PlaceholderWorkspace icon={<Rocket />} title="Deployments" text="Your deployment history will appear here once your site is configured." action="Configure your site" onAction={() => navigate('/dashboard/sites/new')} />} />
            <Route path="commissions" element={<CommissionsPage />} />
            <Route path="bots" element={<PlaceholderWorkspace icon={<Bot />} title="Trading bots" text="Create and manage trading bots for your platform." action="Explore bot builder" onAction={() => navigate('/dashboard/strategies')} />} />
            <Route path="strategies" element={<PlaceholderWorkspace icon={<Blocks />} title="Strategies" text="Browse, organize, and share trading strategies with your community." action="Create a strategy" onAction={() => window.alert('Connect the Deriv bot-builder application to enable strategy creation.')} />} />
            <Route path="support" element={<SupportWorkspace />} />
            <Route path="settings" element={<SettingsWorkspace profile={profile} onProfileChange={onProfileChange} />} />
            <Route path="*" element={<Overview profile={profile} site={site} />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function sectionTitle(pathname: string) {
  const part = pathname.replace(/^\/dashboard\/?/, '').split('/')[0];
  const titles: Record<string, string> = {
    sites: 'Sites', domains: 'Domains', deployments: 'Deployments', commissions: 'Commissions',
    bots: 'Trading bots', strategies: 'Strategies', support: 'Support', settings: 'Settings',
  };
  return titles[part] ?? 'Overview';
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

function Overview({ profile, site }: { profile: Profile; site: SiteDraft }) {
  const navigate = useNavigate();
  return (
    <div className="workspace-page">
      <div className="dashboard-page-title"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>{greeting()}, {profile.name.split(' ')[0]}</h1><p>Here’s a look at your platform and its activity.</p></div><div className="title-actions">{site.name && <Link className="button button-outline" to={`/p/${siteSlug(site.name)}`}><Globe2 size={16} /> View public site</Link>}<button className="button button-gradient" type="button" onClick={() => navigate('/dashboard/sites/new')}><Plus size={16} /> {site.name ? 'Edit your site' : 'Create your site'}</button></div></div>
      <div className="dashboard-kpi-grid">
        <KpiCard icon={<Layers3 />} label="Your sites" value={site.name ? '1' : '0'} note={site.name ? 'One platform configured' : 'Start by creating your first site'} trend="arrow-up" />
        <KpiCard icon={<Wallet />} label="Total commissions" value="$0.00" note="Connect a Deriv account to begin tracking" trend="neutral" />
        <KpiCard icon={<Users />} label="Active traders" value="0" note="Trader activity will show up here" trend="neutral" />
        <KpiCard icon={<Globe2 />} label="Custom domains" value={site.domain ? '1' : '0'} note={site.domain || 'Add a domain when you’re ready'} trend="neutral" />
      </div>
      <div className="dashboard-content-grid">
        <section className="panel activity-panel"><div className="panel-heading"><div><h2>Platform activity</h2><p>Overview of your platform performance</p></div><button className="period-button" type="button">Last 7 days <ChevronDown size={14} /></button></div><div className="empty-chart"><div className="chart-placeholder-grid" /><div className="empty-chart-center"><span className="icon-box"><BarChart3 /></span><b>Your activity will appear here</b><p>Finish setting up your site to start exploring your platform.</p><button className="text-action" type="button" onClick={() => navigate('/dashboard/sites/new')}>Set up your site <ArrowRight size={15} /></button></div></div></section>
        <section className="panel setup-panel"><div className="panel-heading"><div><h2>Getting started</h2><p>Your path to launch</p></div><span className="progress-ring">1<span>/4</span></span></div><div className="setup-checklist"><button type="button" onClick={() => navigate('/dashboard/settings')}><span className="check-step current">1</span><span><b>Complete your profile</b><small>Tell us a little about yourself</small></span><ArrowRight size={15} /></button><button type="button" onClick={() => navigate('/dashboard/sites/new')}><span className={`check-step${site.name ? ' done' : ''}`}>{site.name ? <Check size={13} /> : '2'}</span><span><b>Create your first site</b><small>Choose a name and make it yours</small></span><ArrowRight size={15} /></button><button type="button" onClick={() => navigate('/dashboard/domains')}><span className="check-step">3</span><span><b>Connect a domain</b><small>Use your own website address</small></span><ArrowRight size={15} /></button><button type="button" onClick={() => navigate('/dashboard/deployments')}><span className="check-step">4</span><span><b>Launch your platform</b><small>Review your settings and go live</small></span><ArrowRight size={15} /></button></div></section>
      </div>
      <div className="integration-notice"><ShieldCheck size={17} /><span>This is a frontend prototype. No real Deriv connection, commission data, or live deployment is active.</span></div>
    </div>
  );
}

function KpiCard({ icon, label, value, note, trend }: { icon: ReactNode; label: string; value: string; note: string; trend: string }) {
  return <article className="kpi-card"><div className="kpi-top"><span className="icon-box">{icon}</span>{trend === 'arrow-up' ? <span className="kpi-badge">Getting started</span> : <span className="kpi-neutral"><ArrowDownRight size={14} /></span>}</div><span className="kpi-label">{label}</span><b className="kpi-value">{value}</b><small>{note}</small></article>;
}

function SitesPage({ site, onCreate }: { site: SiteDraft; onCreate: () => void }) {
  const navigate = useNavigate();
  return <div className="workspace-page"><div className="dashboard-page-title"><div><p className="eyebrow">YOUR PLATFORM</p><h1>Site</h1><p>Set up and manage your branded trading platform.</p></div><button className="button button-gradient" type="button" onClick={onCreate}><Plus size={16} /> {site.name ? 'Edit site' : 'Create your site'}</button></div>{site.name ? <article className="site-list-card panel"><span className="site-list-logo" style={{ backgroundColor: site.primaryColor }}>{site.name.slice(0, 1).toUpperCase()}</span><div className="site-list-main"><h2>{site.name}</h2><p>{site.domain || `${siteSlug(site.name)}.emt-demo.test`} · {site.title || 'Trading platform'}</p></div><span className="draft-pill"><i /> Preview</span><Link className="outline-small site-list-link" to={`/p/${siteSlug(site.name)}`} target="_blank" rel="noreferrer">View site</Link><button className="outline-small" type="button" onClick={() => navigate('/dashboard/sites/new')}>Edit setup</button></article> : <EmptyWorkspace icon={<Layers3 />} title="No site found" text="Let’s build your branded trading site. Set up its name, look, and address." action="Create your site" onAction={onCreate} />}</div>;
}

function PublicTradingSite() {
  const { siteSlug: slug = '' } = useParams();
  const site = findPublicSite(slug);

  useEffect(() => {
    document.title = site
      ? `${site.name} — Trading platform`
      : 'Site not found — EPM';
    return () => {
      document.title = 'EPM — Every trader, every opportunity';
    };
  }, [site]);

  if (!site) {
    return (
      <div className="not-found">
        <span className="icon-box"><Globe2 /></span>
        <h1>This platform preview isn’t available</h1>
        <p>Check the link or create a platform preview from your workspace.</p>
        <Link className="button button-gradient" to="/signup">
          Create your platform <ArrowRight size={16} />
        </Link>
      </div>
    );
  }

  return (
    <div className="public-site" style={brandStyle(site.primaryColor)}>
      <header className="public-site-header">
        <Link className="public-brand" to={`/p/${slug}`}>
          <span>{site.name.slice(0, 1).toUpperCase()}</span>{site.name}
        </Link>
        <nav aria-label="Trading platform navigation">
          <a href="#markets">Markets</a>
          <a href="#about-platform">About</a>
        </nav>
        <button className="button public-signin" type="button" onClick={() => window.alert('Trader sign-in needs a secure authentication and Deriv account integration.')}>
          Sign in
        </button>
      </header>
      <main>
        <section className="public-hero">
          <p className="public-live-label"><i className="status-dot" /> YOUR TRADING COMMUNITY</p>
          <h1>{site.title || `Welcome to ${site.name}`}</h1>
          <p>Explore a trading platform by <strong>{site.name}</strong>.</p>
          <button className="button public-trade-button" type="button" onClick={() => window.alert('Live trading is not enabled in this product preview. Connect the authorized Deriv trading flow before launch.')}>
            Explore the platform <ArrowRight size={17} />
          </button>
          <span className="public-powered">Platform owner: {site.name}</span>
        </section>
        <section className="public-markets" id="markets">
          <div className="public-section-heading"><div><p className="eyebrow">MARKET WATCH</p><h2>Explore the markets</h2></div><span>Illustrative preview · not live prices</span></div>
          <div className="market-grid">
            <MarketCard symbol="Volatility 100" short="V100" price="—" change="Synthetic index" positive />
            <MarketCard symbol="Volatility 50" short="V50" price="—" change="Synthetic index" positive />
            <MarketCard symbol="Boom 1000" short="BOOM" price="—" change="Synthetic index" />
            <MarketCard symbol="Crash 1000" short="CRASH" price="—" change="Synthetic index" />
          </div>
        </section>
        <section className="public-about" id="about-platform">
          <div><span className="icon-box"><ShieldCheck /></span><div><h2>A platform for the {site.name} community</h2><p>{site.title || 'Explore trading tools and strategies in one place.'}</p></div></div>
          <div className="public-about-details"><span><Bot size={16} /> Bot strategies</span><span><BarChart3 size={16} /> Market insights</span><span><CircleHelp size={16} /> Platform support</span></div>
        </section>
        <section className="public-risk-notice"><ShieldCheck size={16} /><p>This is a site preview. Trading, account access, live prices, and financial services are not connected. Trading involves risk; only participate through authorized, properly configured services.</p></section>
      </main>
      <footer className="public-site-footer"><Link className="public-brand" to={`/p/${slug}`}><span>{site.name.slice(0, 1).toUpperCase()}</span>{site.name}</Link><small>Powered by EPM · Every trader, every opportunity.</small></footer>
    </div>
  );
}

function MarketCard({ symbol, short, price, change, positive = false }: { symbol: string; short: string; price: string; change: string; positive?: boolean }) {
  return <article className="market-card"><div className="market-card-top"><span className="market-symbol">{short}</span><span className="market-category">SYNTHETIC</span></div><h3>{symbol}</h3><div className="market-price"><b>{price}</b><span className={positive ? 'market-positive' : ''}>{change}</span></div><div className="market-sparkline" aria-hidden="true"><svg viewBox="0 0 200 42" preserveAspectRatio="none"><path d={positive ? 'M0 32 C24 31 24 20 49 25 S78 30 97 17 S128 26 147 12 S176 16 200 4' : 'M0 8 C20 12 27 29 50 20 S81 16 103 30 S130 16 149 25 S180 14 200 31'} fill="none" stroke="var(--brand-accent)" strokeWidth="2" /></svg></div></article>;
}

function SiteWizard({ site, updateSite, saveSite, saved, step, setStep }: { site: SiteDraft; updateSite: (key: keyof SiteDraft, value: string) => void; saveSite: (event: FormEvent<HTMLFormElement>) => void; saved: boolean; step: number; setStep: (step: number) => void }) {
  const navigate = useNavigate();
  return <div className="workspace-page"><button className="back-link" type="button" onClick={() => navigate('/dashboard/sites')}><ChevronLeft size={15} /> Back to sites</button><div className="wizard-header"><div><p className="eyebrow">SITE SETUP</p><h1>Create your platform</h1><p>Bring your trading brand to life. You can update these settings any time.</p></div><span className="wizard-counter">STEP {String(step).padStart(2, '0')} <i>/ 04</i></span></div><div className="wizard-steps">{['Basics', 'Brand', 'Domain', 'Review'].map((label, index) => <button type="button" key={label} className={`wizard-step${step === index + 1 ? ' active' : ''}${step > index + 1 ? ' complete' : ''}`} onClick={() => setStep(index + 1)}><span>{step > index + 1 ? <Check size={13} /> : `0${index + 1}`}</span>{label}</button>)}</div><form className="wizard-form panel" onSubmit={saveSite}>{step === 1 && <><div className="wizard-form-heading"><span className="icon-box"><Layers3 /></span><div><h2>Let’s add the basics</h2><p>Start with the details your visitors will see.</p></div></div><label>Site name<input required value={site.name} onChange={(event) => updateSite('name', event.target.value)} placeholder="e.g. Global Trade Alliance" /></label><label>Site title<input required value={site.title} onChange={(event) => updateSite('title', event.target.value)} placeholder="e.g. Smarter trading starts here" /></label><p className="field-help">Your site title is a short line to describe your trading platform.</p></>}{step === 2 && <><div className="wizard-form-heading"><span className="icon-box"><Palette /></span><div><h2>Make it your brand</h2><p>Choose a color and preview your site's identity.</p></div></div><label>Brand color<span className="color-picker-row"><input aria-label="Brand color" type="color" value={site.primaryColor} onChange={(event) => updateSite('primaryColor', event.target.value)} /><span>{site.primaryColor.toUpperCase()}</span></span></label><div className="brand-preview-card" style={{ '--brand-accent': site.primaryColor } as CSSProperties}><span className="brand-preview-symbol">{site.name ? site.name[0].toUpperCase() : 'Y'}</span><span><b>{site.name || 'Your Brand'}</b><small>{site.title || 'Your trading platform'}</small></span><span className="brand-preview-button">Explore</span></div><p className="field-help">Logo upload and custom font choices can be added when storage and upload endpoints are configured.</p></>}{step === 3 && <><div className="wizard-form-heading"><span className="icon-box"><Globe2 /></span><div><h2>Choose your address</h2><p>Connect a domain or add it whenever you’re ready.</p></div></div><label>Custom domain <span className="optional-label">OPTIONAL</span><input value={site.domain} onChange={(event) => updateSite('domain', event.target.value)} placeholder="e.g. trade.yourbrand.com" /></label><div className="domain-note"><Globe2 size={17} /><span>Domain verification and DNS changes are not available in this preview.</span></div></>}{step === 4 && <><div className="wizard-form-heading"><span className="icon-box"><ShieldCheck /></span><div><h2>Review your platform</h2><p>Here’s the setup information you’ve entered.</p></div></div><div className="review-list"><div><span>Platform name</span><b>{site.name || 'Not set yet'}</b></div><div><span>Platform tagline</span><b>{site.title || 'Not set yet'}</b></div><div><span>Custom domain</span><b>{site.domain || 'Add later'}</b></div><div><span>Brand color</span><b><i style={{ backgroundColor: site.primaryColor }} /> {site.primaryColor.toUpperCase()}</b></div></div><div className="domain-note"><ShieldCheck size={17} /><span>Saving stores a demo draft in this browser. It does not deploy a live site.</span></div></>}{saved && <div className="inline-success"><Check size={16} /> Demo draft saved in this browser.</div>}<div className="wizard-actions"><button className="button button-outline" type="button" onClick={() => step > 1 ? setStep(step - 1) : navigate('/dashboard/sites')}>{step === 1 ? 'Cancel' : 'Back'}</button>{step < 4 ? <button className="button button-gradient" type="button" disabled={step === 1 && !site.name.trim()} onClick={() => setStep(step + 1)}>Continue <ArrowRight size={16} /></button> : <button className="button button-gradient" type="submit" disabled={!site.name.trim()}>Save draft <Check size={16} /></button>}{step === 4 && <button className="button button-outline" type="button" onClick={() => window.alert('Live deployment is not connected in this prototype.')}>Deploy site <Rocket size={15} /></button>}</div></form></div>;
}

function CommissionsPage() {
  return (
    <div className="workspace-page">
      <div className="dashboard-page-title">
        <div>
          <p className="eyebrow">YOUR SITE EARNINGS</p>
          <h1>Monthly commissions</h1>
          <p>Your share accrues as eligible trades happen and is settled after the platform operator receives Deriv’s monthly payout.</p>
        </div>
        <button className="button button-outline" type="button" onClick={() => window.alert('Payout details need a verified payment provider and live integration.')}>
          <CreditCard size={16} /> Payout settings
        </button>
      </div>
      <div className="dashboard-kpi-grid">
        <KpiCard icon={<Wallet />} label="Your accrued share" value="$0.00" note="85% of eligible commission attributed to your site" trend="neutral" />
        <KpiCard icon={<TrendingUp />} label="Your share of commission pool" value="85%" note="Illustrative owner rate; final terms must be agreed" trend="neutral" />
        <KpiCard icon={<CreditCard />} label="Next settlement" value="Monthly" note="Paid after the platform operator receives Deriv’s payout" trend="neutral" />
        <KpiCard icon={<Users />} label="Previous payouts" value="$0.00" note="No payments recorded in this preview" trend="neutral" />
      </div>
      <section className="panel commissions-empty">
        <span className="icon-box"><Wallet /></span>
        <p className="eyebrow">MONTHLY SETTLEMENT FLOW</p>
        <h2>Your eligible trade activity adds up during the month.</h2>
        <p>The generated commission is treated as a 100% pool. EPM receives the monthly partner payment, reconciles activity for your site, and pays your 85% share. Your site account does not show the operator’s Deriv account or administrative controls.</p>
        <div className="settlement-steps">
          <div><span>01</span><b>Eligible trade</b><small>Activity is attributed to your site</small></div>
          <ArrowRight size={17} />
          <div><span>02</span><b>Monthly payout</b><small>Deriv pays the platform operator</small></div>
          <ArrowRight size={17} />
          <div><span>03</span><b>Your settlement</b><small>Your agreed share is paid to you</small></div>
        </div>
        <div className="split-example">
          <div><small>Total commission pool</small><b>$10.00 · 100%</b></div>
          <span>→</span>
          <div><small>EPM platform share</small><b>$1.50 · 15%</b></div>
          <span>+</span>
          <div><small>Your site-owner share</small><b>$8.50 · 85%</b></div>
        </div>
        <span className="demo-warning"><ShieldCheck size={15} /> Preview only: trade attribution, accrued balances, monthly reconciliation, and payouts are not connected.</span>
      </section>
    </div>
  );
}

function SettingsWorkspace({ profile, onProfileChange }: { profile: Profile; onProfileChange: (profile: Profile) => void }) {
  const [name, setName] = useState(profile.name);
  const [saved, setSaved] = useState(false);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const updated = { ...profile, name: name.trim() };
    localStorage.setItem(profileKey, JSON.stringify(updated));
    onProfileChange(updated);
    setSaved(true);
  }
  return <div className="workspace-page"><div className="dashboard-page-title"><div><p className="eyebrow">PREFERENCES</p><h1>Settings</h1><p>Manage your profile and workspace details.</p></div></div><form className="panel settings-form" onSubmit={save}><div className="panel-heading"><div><h2>Profile details</h2><p>Update the name shown in your workspace.</p></div><span className="icon-box"><Users /></span></div><label>Full name<input required value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} /></label><label>Email address<input value={profile.email} disabled /></label>{saved && <div className="inline-success"><Check size={16} /> Profile saved in this browser.</div>}<button className="button button-gradient" type="submit">Save changes</button><p className="field-help">Profile information is stored locally in this demo. Use an authentication service before production.</p></form></div>;
}

function SupportWorkspace() {
  return <div className="workspace-page"><div className="dashboard-page-title"><div><p className="eyebrow">WE’RE HERE TO HELP</p><h1>Support</h1><p>Browse the help center or talk to the EPM team.</p></div></div><div className="support-cards"><article className="panel"><span className="icon-box"><CircleHelp /></span><h2>Help center</h2><p>Find useful guides about setting up your platform, domains, and brand.</p><Link className="text-action" to="/how-it-works">Browse setup guides <ArrowRight size={15} /></Link></article><article className="panel"><span className="icon-box"><LifeBuoy /></span><h2>Contact the team</h2><p>For questions about your account and platform setup, send the team a message.</p><Link className="text-action" to="/contact">Get in touch <ArrowRight size={15} /></Link></article></div></div>;
}

function PlaceholderWorkspace({ icon, title, text, action, onAction }: { icon: ReactNode; title: string; text: string; action: string; onAction: () => void }) {
  return <div className="workspace-page"><div className="dashboard-page-title"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>{title}</h1><p>{text}</p></div></div><EmptyWorkspace icon={icon} title={title === 'Deployments' ? 'Nothing deployed yet' : `Let’s set up ${title.toLowerCase()}`} text={text} action={action} onAction={onAction} /></div>;
}

function EmptyWorkspace({ icon, title, text, action, onAction }: { icon: ReactNode; title: string; text: string; action: string; onAction: () => void }) {
  return <section className="panel empty-workspace"><span className="empty-illustration">{icon}</span><h2>{title}</h2><p>{text}</p><button className="button button-gradient" type="button" onClick={onAction}>{action} <ArrowRight size={16} /></button></section>;
}

function SupportPageForDemo() {
  return <PageWrap title="Page not found" intro="That page isn’t part of the current preview."><Link className="button button-gradient" to="/">Back to home <ArrowRight size={16} /></Link></PageWrap>;
}

function CtaStrip({ title }: { title: string }) {
  return <section className="cta-strip"><div><p className="eyebrow"><span /> GET STARTED</p><h2>{title}</h2></div><a className="button button-gradient button-large" href={OWNER_URL}>Create your platform <ArrowRight size={17} /></a></section>;
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <div className="footer-brand-block">
          <Link to="/" className="brand"><span className="brand-mark"><CircleDollarSign size={23} strokeWidth={2.2} /></span><span>EPM</span></Link>
          <p>Executive Prime Markets provides white-label tools for running your own Deriv-powered trading platform.</p>
        </div>
        <div className="footer-col"><b>Product</b><Link to="/features">Features</Link><Link to="/how-it-works">How it works</Link></div>
        <div className="footer-col"><b>Company</b><Link to="/about">About</Link><Link to="/contact">Contact</Link></div>
        <div className="footer-col"><b>Legal</b><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link></div>
      </div>
      <p className="footer-risk">Risk warning: trading on Deriv, including synthetic indices and digital options, carries a high risk of loss and is not suitable for everyone. Commission depends on client trading activity and is not guaranteed.</p>
      <div className="footer-bottom"><span>© 2026 EPM (Executive Prime Markets). All rights reserved.</span><span>Independent platform provider using Deriv’s trading services.</span></div>
    </footer>
  );
}

function NotFound() {
  return <SupportPageForDemo />;
}

export default App;
