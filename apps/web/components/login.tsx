"use client";
import { useEffect, useState } from "react";
import { api, errorMessage, type User } from "./client";
import { AppearanceControls, Brand, ErrorBanner, Icon } from "./ui";
import { useLocale } from "./locale";
export function Login() {
    const { tr } = useLocale();
    const [register, setRegister] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => { api<{
        user: User;
    } | null>("/api/auth/get-session").then(data => { if (data?.user)
        window.location.replace("/workspaces"); }).catch(() => { }); }, []);
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
            await api(`/api/auth/${register ? "sign-up" : "sign-in"}/email`, { method: "POST", body: JSON.stringify({ email, password, ...(register ? { name: name.trim() || email.split("@")[0] } : {}) }) });
            window.location.replace("/workspaces");
        }
        catch (err) {
            setError(errorMessage(err));
            setBusy(false);
        }
    }
    return <main className="login-page">
        <div className="login-brand"><Brand /><AppearanceControls compact/></div>
        <section className="login-story">
            <div className="eyebrow"><span className="tiny-line"/>{tr("让想法落地", "A PLACE TO MAKE THINGS")}</div>
            <h1>{tr("下一个想法，", "Your next idea.")}<br />{tr("从这里", "Room to ")}<em>{tr("开始。", "work.")}</em></h1>
            <p>{tr("文件与工作持续保存，Agent 随时与你协作。", "A persistent workspace, your own runtime, and an agent that works alongside you.")}</p>
            <div className="login-visual" aria-hidden="true"><div className="visual-top"><span /><span /><span /><span className="visual-title">workspace</span></div><div className="visual-body"><div className="visual-tree"><div><Icon name="folder"/>my-project</div><div><Icon name="file"/>src</div><div><Icon name="file"/>README.md</div><div className="visual-tree-line"/><div className="visual-tree-line short"/></div><div className="visual-agent"><Icon name="logo" size={30}/><div className="visual-line"/><div className="visual-line mid"/><div className="visual-line short"/><div className="visual-cursor"/></div></div><div className="visual-bottom"><span className="status-dot status-running"/>{tr("你的空间，随时可用", "YOUR SPACE. ALWAYS HERE.")}</div></div>
            <div className="login-footnote">{tr("文件留下，工作继续。", "FILES THAT STAY. WORK THAT MOVES FORWARD.")}</div>
        </section>
        <section className="login-form-region"><div className="login-form-wrap">
            <div className="eyebrow">{tr("开始工作", "LET’S GET TO WORK")}</div>
            <h2>{register ? tr("创建账号", "Create your account") : tr("欢迎回来", "Welcome back")}</h2>
            <p className="muted">{register ? tr("为下一个项目创建工作空间。", "Make a space for your next project.") : tr("从上次停下的地方继续。", "Pick up right where you left off.")}</p>
            <form onSubmit={submit} className="auth-form">
                {register && <label>{tr("姓名", "Name")}<input autoComplete="name" placeholder={tr("你的姓名", "Your name")} value={name} onChange={e => setName(e.target.value)} required maxLength={100}/></label>}
                <label>{tr("邮箱地址", "Email address")}<input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254}/></label>
                <label>{tr("密码", "Password")}<input type="password" autoComplete={register ? "new-password" : "current-password"} placeholder={register ? tr("至少 12 个字符", "At least 12 characters") : tr("输入密码", "Enter your password")} minLength={register ? 12 : undefined} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required/></label>
                {error && <ErrorBanner message={error}/>}
                <button className="button button-primary auth-submit" disabled={busy}>{busy ? <><span className="spinner"/>{register ? tr("正在创建账号…", "Creating account…") : tr("正在登录…", "Signing in…")}</> : <>{register ? tr("创建账号", "Create account") : tr("登录", "Sign in")}<Icon name="arrow"/></>}</button>
            </form>
            <p className="auth-switch">{register ? tr("已有账号？", "Already have an account?") : tr("还没有 Cloud Work 账号？", "New to Cloud Work?")} <button onClick={() => { setRegister(!register); setError(""); }} className="text-button" disabled={busy}>{register ? tr("登录", "Sign in") : tr("创建账号", "Create an account")}</button></p>
            <div className="auth-note"><Icon name="code" size={16}/><span>{tr("一个账号，保存文件、工具与对话。", "One account. Your files, tools, and conversations.")}</span></div>
        </div></section>
    </main>;
}
