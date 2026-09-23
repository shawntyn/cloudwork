import { db, users } from "@cloud-work/database";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { api, body, currentUser } from "@/server/api";

export const dynamic = "force-dynamic";

export const GET = api(async request => {
    const user = await currentUser(request);
    const [preferences] = await db.select({ theme: users.uiTheme, locale: users.uiLocale }).from(users).where(eq(users.id, user.id)).limit(1);
    return Response.json(preferences ?? { theme: "system", locale: "auto" });
});

export const PATCH = api(async request => {
    const user = await currentUser(request);
    const update = z.object({
        theme: z.enum(["system", "light", "dark"]).optional(),
        locale: z.enum(["auto", "zh-CN", "en"]).optional(),
    }).strict().refine(value => value.theme !== undefined || value.locale !== undefined).parse(await body(request, 1024));
    const [preferences] = await db.update(users).set({
        ...(update.theme === undefined ? {} : { uiTheme: update.theme }),
        ...(update.locale === undefined ? {} : { uiLocale: update.locale }),
    }).where(eq(users.id, user.id)).returning({ theme: users.uiTheme, locale: users.uiLocale });
    return Response.json(preferences);
});
