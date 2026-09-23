"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { GUEST_LOCALE_COOKIE, GUEST_THEME_COOKIE, isLocalePreference, isThemePreference, LOCALE_COOKIE, resolveLocale, THEME_COOKIE, type Locale, type LocalePreference, type ThemePreference } from "./locale-core";

type LocaleContextValue = {
    locale: Locale;
    theme: ThemePreference;
    localePreference: LocalePreference;
    tr: (zh: string, en: string) => string;
    setTheme: (value: ThemePreference) => Promise<void>;
    setLocale: (value: LocalePreference) => Promise<void>;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function writeCookie(name: string, value: string) {
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
function readCookie(name: string) {
    return document.cookie.split("; ").find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function clearCookie(name: string) {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function browserLanguages() {
    return navigator.languages?.length ? navigator.languages : [navigator.language];
}

export function LocaleProvider({ children, initialTheme, initialLocalePreference, initialLocale }: {
    children: React.ReactNode;
    initialTheme: ThemePreference;
    initialLocalePreference: LocalePreference;
    initialLocale: Locale;
}) {
    const pathname = usePathname();
    const [theme, setThemeState] = useState(initialTheme);
    const [localePreference, setLocalePreference] = useState(initialLocalePreference);
    const [locale, setResolvedLocale] = useState(initialLocale);

    useEffect(() => {
        if (localePreference === "auto") setResolvedLocale(resolveLocale("auto", browserLanguages()));
    }, [localePreference]);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;
    }, [theme]);

    useEffect(() => {
        document.documentElement.lang = locale;
    }, [locale]);

    useEffect(() => {
        if (pathname === "/login") return;
        const controller = new AbortController();
        void fetch("/api/preferences", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
            .then(async response => response.ok ? response.json() as Promise<{ theme: unknown; locale: unknown }> : null)
            .then(async data => {
                if (controller.signal.aborted || !data) return;
                const guestTheme = readCookie(GUEST_THEME_COOKIE);
                const guestLocale = readCookie(GUEST_LOCALE_COOKIE);
                const update: { theme?: ThemePreference; locale?: LocalePreference } = {};
                if (data.theme === "system" && isThemePreference(guestTheme)) update.theme = guestTheme;
                if (data.locale === "auto" && isLocalePreference(guestLocale)) update.locale = guestLocale;
                if (Object.keys(update).length) {
                    const response = await fetch("/api/preferences", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(update), signal: controller.signal });
                    if (!response.ok) return; // Keep the guest preference for a later retry.
                    data = await response.json() as { theme: unknown; locale: unknown };
                }
                clearCookie(GUEST_THEME_COOKIE);
                clearCookie(GUEST_LOCALE_COOKIE);
                if (isThemePreference(data.theme)) {
                    setThemeState(data.theme);
                    writeCookie(THEME_COOKIE, data.theme);
                }
                if (isLocalePreference(data.locale)) {
                    setLocalePreference(data.locale);
                    setResolvedLocale(resolveLocale(data.locale, browserLanguages()));
                    writeCookie(LOCALE_COOKIE, data.locale);
                }
            }).catch(() => {});
        return () => controller.abort();
    }, [pathname]);

    const persist = useCallback(async (update: { theme?: ThemePreference; locale?: LocalePreference }) => {
        const response = await fetch("/api/preferences", {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(update),
        });
        if (response.status === 401) return false; // Before sign-in, browser cookies keep the selected appearance.
        if (!response.ok) throw new Error(response.status >= 500 ? "Could not sync preferences. Try again." : "Could not save preferences.");
        return true;
    }, []);

    const setTheme = useCallback(async (value: ThemePreference) => {
        setThemeState(value);
        writeCookie(THEME_COOKIE, value);
        if (pathname === "/login") writeCookie(GUEST_THEME_COOKIE, value);
        if (!await persist({ theme: value })) writeCookie(GUEST_THEME_COOKIE, value);
    }, [pathname, persist]);

    const setLocale = useCallback(async (value: LocalePreference) => {
        setLocalePreference(value);
        setResolvedLocale(resolveLocale(value, browserLanguages()));
        writeCookie(LOCALE_COOKIE, value);
        if (pathname === "/login") writeCookie(GUEST_LOCALE_COOKIE, value);
        if (!await persist({ locale: value })) writeCookie(GUEST_LOCALE_COOKIE, value);
    }, [pathname, persist]);

    const tr = useCallback((zh: string, en: string) => locale === "zh-CN" ? zh : en, [locale]);
    const context = useMemo(() => ({ locale, theme, localePreference, tr, setTheme, setLocale }), [locale, theme, localePreference, tr, setTheme, setLocale]);
    return <LocaleContext.Provider value={context}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
    const context = useContext(LocaleContext);
    if (!context) throw new Error("useLocale must be used inside LocaleProvider");
    return context;
}
