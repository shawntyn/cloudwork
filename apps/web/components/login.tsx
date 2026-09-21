"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, type User } from "./client";
import { Brand, ErrorBanner, Icon } from "./ui";
export function Login() {
    const router = useRouter();
    const [register, setRegister] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => { api<{
        user: User;
    } | null>("/api/auth/get-session").then(data => { if (data?.user)
        router.replace("/workspaces"); }).catch(() => { }); }, [router]);
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
            await api(`/api/auth/${register ? "sign-up" : "sign-in"}/email`, { method: "POST", body: JSON.stringify({ email, password, ...(register ? { name: name.trim() || email.split("@")[0] } : {}) }) });
            router.replace("/workspaces");
        }
        catch (err) {
            setError(errorMessage(err));
            setBusy(false);
        }
    }
    return <main className="login-page"><div className="login-brand"><Brand /></div><section className="login-story"><div className="eyebrow"><span className="tiny-line"/>A PLACE TO MAKE THINGS</div><h1>Your next idea.<br />Room to <em>work.</em></h1><p>A persistent workspace, your own runtime,<br className="desktop-only"/> and an agent that works alongside you.</p><div className="login-visual" aria-hidden="true"><div className="visual-top"><span /><span /><span /><span className="visual-title">workspace</span></div><div className="visual-body"><div className="visual-tree"><div><Icon name="folder"/>my-project</div><div><Icon name="file"/>src</div><div><Icon name="file"/>README.md</div><div className="visual-tree-line"/><div className="visual-tree-line short"/></div><div className="visual-agent"><Icon name="logo" size={30}/><div className="visual-line"/><div className="visual-line mid"/><div className="visual-line short"/><div className="visual-cursor"/></div></div><div className="visual-bottom"><span className="status-dot status-running"/>YOUR SPACE. ALWAYS HERE.</div></div><div className="login-footnote">FILES THAT STAY. WORK THAT MOVES FORWARD.</div></section><section className="login-form-region"><div className="login-form-wrap"><div className="eyebrow">LET’S GET TO WORK</div><h2>{register ? "Create your account" : "Welcome back"}</h2><p className="muted">{register ? "Make a space for your next project." : "Pick up right where you left off."}</p><form onSubmit={submit} className="auth-form">{register && <label>Name<input autoComplete="name" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required maxLength={100}/></label>}<label>Email address<input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254}/></label><label>Password<input type="password" autoComplete={register ? "new-password" : "current-password"} placeholder={register ? "At least 8 characters" : "Enter your password"} minLength={register ? 8 : undefined} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required/></label>{error && <ErrorBanner message={error}/>}<button className="button button-primary auth-submit" disabled={busy}>{busy ? <><span className="spinner"/>{register ? "Creating account…" : "Signing in…"}</> : <>{register ? "Create account" : "Sign in"}<Icon name="arrow"/></>}</button></form><p className="auth-switch">{register ? "Already have an account?" : "New to Cloud Work?"} <button onClick={() => { setRegister(!register); setError(""); }} className="text-button" disabled={busy}>{register ? "Sign in" : "Create an account"}</button></p><div className="auth-note"><Icon name="code" size={16}/><span>One account. Your files, tools, and conversations.</span></div></div></section></main>;
}
