import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { auth } from "@cloud-work/auth";
import { db, users } from "@cloud-work/database";
import { eq } from "drizzle-orm";
import { LocaleProvider } from "../components/locale";
import { acceptLanguages, GUEST_LOCALE_COOKIE, GUEST_THEME_COOKIE, isLocalePreference, isThemePreference, LOCALE_COOKIE, resolveLocale, THEME_COOKIE } from "../components/locale-core";
import "./globals.css";
import "./workspace-redesign.css";
import "./file-workbench.css";
import "./rich-content.css";
import "./conversation-ux.css";

export const metadata: Metadata = {
  title: "Cloud Work",
  description: "Cloud Work agent workspace",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  let theme = isThemePreference(themeCookie) ? themeCookie : "system";
  let localePreference = isLocalePreference(localeCookie) ? localeCookie : "auto";
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (session?.user.id) {
    const [preferences] = await db.select({ theme: users.uiTheme, locale: users.uiLocale }).from(users).where(eq(users.id, session.user.id)).limit(1);
    if (preferences) {
      const guestTheme = cookieStore.get(GUEST_THEME_COOKIE)?.value;
      const guestLocale = cookieStore.get(GUEST_LOCALE_COOKIE)?.value;
      theme = preferences.theme === "system" && isThemePreference(guestTheme) ? guestTheme : preferences.theme;
      localePreference = preferences.locale === "auto" && isLocalePreference(guestLocale) ? guestLocale : preferences.locale;
    }
  }
  const locale = resolveLocale(localePreference, acceptLanguages(requestHeaders.get("accept-language")));
  return <html lang={locale} data-theme={theme} suppressHydrationWarning><body><LocaleProvider initialTheme={theme} initialLocalePreference={localePreference} initialLocale={locale}>{children}</LocaleProvider></body></html>;
}
