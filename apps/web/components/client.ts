"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
export type User = {
    id: string;
    name: string;
    email: string;
};
export type Workspace = {
    id: string;
    name: string;
    path: string;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    purgeStartedAt: string | null;
};
export type Session = {
    id: string;
    status: string;
    workspaceId: string;
    workspaceName?: string;
    title: string | null;
    firstMessageAt: string | null;
    lastActivityAt: string;
    pinnedAt: string | null;
    archivedAt: string | null;
    hasMessages: boolean;
    confirmedBlank: boolean;
    pinned: boolean;
    archived: boolean;
    createdAt: string;
    updatedAt: string;
};
export type Runtime = {
    status: "STARTING" | "RUNNING" | "IDLE" | "STOPPED" | "REMOVED" | "ERROR";
    lastActiveAt?: string;
};
export type FileEntry = {
    name: string;
    path: string;
    type: "file" | "directory" | "symlink";
    size: number;
    modifiedAt: number;
};
export class ApiClientError extends Error {
    constructor(message: string, public code: string, public status: number) { super(message); }
}
const localizedErrors: Record<string, [string, string]> = {
    DESKTOP_TAKEOVER_PENDING: ["原任务尚未确认停止，暂不能接管。请稍后重试。", "The owning task has not confirmed stopping. Retry takeover shortly."],
    DESKTOP_DISABLED: ["电脑功能尚未启用。", "Computer is not enabled."],
    DESKTOP_UNAVAILABLE: ["电脑暂不可用，请稍后重试。", "Desktop unavailable. Try again shortly."],
    DESKTOP_CAPACITY: ["运行中的电脑数量已达上限，请稍后重试。", "Desktop capacity reached. Try again later."],
    DESKTOP_BUSY: ["另一个标签页正在控制电脑。", "Another tab is controlling the desktop."],
    DESKTOP_CONTROL_LOST: ["电脑控制权已变更，请刷新状态。", "Desktop control changed. Refresh its status."],
    DESKTOP_STORAGE_FULL: ["电脑存储空间不足。", "Desktop storage is full."],
    COMPUTER_RUN_STOPPED: ["本轮电脑任务已停止，请发送新消息后继续。", "This computer run was stopped. Send a new message to continue."],
    COMPUTER_MANUAL_TAKEOVER: ["已人工接管。交还后请在原对话中发送消息继续。", "Manual takeover completed. Release control and send a message in the original conversation to continue."],
    COMPUTER_CANCELLED: ["电脑任务已停止。", "Computer task stopped."],
    COMPUTER_WORKSPACE_STOPPED: ["工作区电脑已停止。", "Workspace computer stopped."],
    COMPUTER_INTERRUPTED: ["执行已中断；继续前会重新观察当前电脑。", "Execution interrupted; continuation must observe the current desktop."],
    COMPUTER_START_FAILED: ["电脑任务未能启动，请检查桌面状态后重试。", "Computer task could not start. Check the desktop and retry."],
    COMPUTER_CONFIRMATION_SCREEN_CHANGED: ["确认期间画面发生变化，此次操作未执行。请发送消息重新检查。", "The screen changed during confirmation; the action was not executed. Send a message to recheck."],
    COMPUTER_REPEATED_ACTION: ["重复操作未取得进展，任务已停止。", "Repeated actions made no progress; the task was stopped."],
    COMPUTER_TIME_BUDGET: ["电脑任务已达到时间上限。", "Computer task reached its time limit."],
    COMPUTER_MODEL_NOT_CONFIGURED: ["尚未配置视觉模型。", "Vision model is not configured."],
    COMPUTER_QUEUE_FULL: ["电脑任务队列已满。", "The computer task queue is full."],
    COMPUTER_PARENT_ENDED: ["所属 Agent 运行已结束。", "The parent agent run has ended."],
    COMPUTER_BUDGET: ["电脑任务已达到执行预算。", "Computer task budget reached."],
    INVALID_EMAIL: ["邮箱地址无效。", "Enter a valid email address."],
    INVALID_EMAIL_OR_PASSWORD: ["邮箱或密码不正确。", "Email or password is incorrect."],
    PASSWORD_TOO_SHORT: ["密码至少需要 12 个字符。", "Password must be at least 12 characters."],
    PASSWORD_TOO_LONG: ["密码过长。", "Password is too long."],
    USER_ALREADY_EXISTS: ["此邮箱已注册，请直接登录。", "This email is already registered. Sign in instead."],
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: ["此邮箱已注册，请直接登录或使用其他邮箱。", "This email is already registered. Sign in or use another email."],
    UNAUTHENTICATED: ["请先登录后继续。", "Please sign in to continue."],
    FORBIDDEN: ["你没有执行此操作的权限。", "You do not have permission to do this."],
    ORIGIN_MISMATCH: ["当前访问地址未被服务器允许，请联系管理员检查站点地址。", "This site address is not allowed by the server. Ask an administrator to check the site URL."],
    IDEMPOTENCY_KEY_CONFLICT: ["这条消息的重试编号已用于其他内容。请重新发送。", "This retry identifier was used for different text. Send the message again."],
    NOT_FOUND: ["没有找到所请求的内容。", "The requested item was not found."],
    WORKSPACE_NOT_FOUND: ["找不到这个工作区。它可能已被删除。", "This workspace was not found. It may have been deleted."],
    WORKSPACE_RESTORE_EXPIRED: ["工作区已过恢复期限，正在等待彻底删除。", "This workspace can no longer be restored and is awaiting permanent deletion."],
    SESSION_NOT_FOUND: ["找不到这个对话。它可能已被删除。", "This conversation was not found. It may have been deleted."],
    INVALID_PATH: ["文件路径必须位于当前工作区内。", "The file path must stay inside this workspace."],
    CONFLICT: ["内容已变更，请刷新后重试。", "This item changed. Refresh and try again."],
    INVALID_REQUEST: ["提交的信息有误，请检查后重试。", "Check the information and try again."],
    PAYLOAD_TOO_LARGE: ["文件或请求内容过大。", "The file or request is too large."],
    UNSUPPORTED_MEDIA_TYPE: ["不支持这种内容格式。", "This content format is not supported."],
    RATE_LIMITED: ["操作过于频繁，请稍后重试。", "Too many requests. Please try again shortly."],
    SERVICE_UNAVAILABLE: ["服务暂时不可用，请稍后重试。", "The service is temporarily unavailable. Please try again."],
    INTERNAL_ERROR: ["操作未能完成，请重试。", "The request could not be completed. Please try again."],
    REQUEST_FAILED: ["操作未能完成，请重试。", "The request could not be completed. Please try again."],
};
function currentLocale() { return typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "zh-CN"; }
export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
        cache: "no-store",
        ...init,
        credentials: "same-origin",
        headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
    const data = await response.json().catch(() => null) as ({
        error?: string;
        message?: string;
        code?: string;
    } & T) | null;
    if (!response.ok)
        throw new ApiClientError(data?.error || data?.message || `Request failed (${response.status}). Please try again.`, data?.code || "REQUEST_FAILED", response.status);
    return data as T;
}
export function computerResult(value: string): string {
    const message = localizedErrors[value];
    if (message) return message[currentLocale() === "zh-CN" ? 0 : 1];
    if (/^COMPUTER_[A-Z_0-9]+$/.test(value)) return (currentLocale() === "zh-CN" ? "电脑任务未完成，错误编号：" : "Computer task did not complete. Error: ") + value;
    return value;
}
export function errorMessage(error: unknown) {
    if (error instanceof ApiClientError) {
        const message = localizedErrors[error.code];
        if (message) return message[currentLocale() === "zh-CN" ? 0 : 1];
    }
    if (error instanceof TypeError) return currentLocale() === "zh-CN" ? "网络连接失败，请检查连接后重试。" : "Network request failed. Check your connection and try again.";
    return error instanceof Error ? error.message : currentLocale() === "zh-CN" ? "发生错误，请重试。" : "Something went wrong. Please try again.";
}
export function useUser() {
    const router = useRouter();
    const [user, setUser] = useState<User | null>(null);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setError("");
        api<{
            user: User;
        } | null>("/api/auth/get-session", { signal: controller.signal })
            .then(data => { if (data?.user)
            setUser(data.user);
        else
            router.replace("/login"); })
            .catch(err => { if (!controller.signal.aborted)
            setError(errorMessage(err)); });
        return () => controller.abort();
    }, [router, retry]);
    return { user, error, retry: () => setRetry(value => value + 1) };
}
export function shortDate(date: string) {
    return new Intl.DateTimeFormat(currentLocale(), { month: "short", day: "numeric" }).format(new Date(date));
}
