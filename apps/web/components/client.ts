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
};
export type Session = {
    id: string;
    status: string;
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
};
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
    } & T) | null;
    if (!response.ok)
        throw new Error(data?.error || data?.message || `Request failed (${response.status}). Please try again.`);
    return data as T;
}
export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "Something went wrong. Please try again.";
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
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(date));
}
