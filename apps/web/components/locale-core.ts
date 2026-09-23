export type ThemePreference = "system" | "light" | "dark";
export type LocalePreference = "auto" | "zh-CN" | "en";
export type Locale = "zh-CN" | "en";

export const THEME_COOKIE = "cw_theme";
export const LOCALE_COOKIE = "cw_locale";
export const GUEST_THEME_COOKIE = "cw_guest_theme";
export const GUEST_LOCALE_COOKIE = "cw_guest_locale";

export function isThemePreference(value: unknown): value is ThemePreference {
    return value === "system" || value === "light" || value === "dark";
}

export function isLocalePreference(value: unknown): value is LocalePreference {
    return value === "auto" || value === "zh-CN" || value === "en";
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[] = []): Locale {
    if (preference !== "auto") return preference;
    for (const language of languages) {
        const normalized = language.trim().toLowerCase();
        if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
        if (normalized === "en" || normalized.startsWith("en-")) return "en";
    }
    return "zh-CN";
}

export function acceptLanguages(value: string | null): string[] {
    if (!value) return [];
    return value.split(",")
        .map(entry => {
            const [language, ...parameters] = entry.trim().split(";");
            const qualityParameter = parameters.find(parameter => /^\s*q\s*=/.test(parameter));
            const quality = qualityParameter?.split("=")[1]?.trim();
            return { language: language?.trim() ?? "", quality: quality === undefined ? 1 : Number(quality) };
        })
        .filter(entry => entry.language && Number.isFinite(entry.quality) && entry.quality > 0)
        .sort((left, right) => right.quality - left.quality)
        .map(entry => entry.language);
}
