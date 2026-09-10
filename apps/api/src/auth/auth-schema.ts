import { pgSchema, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";

export function createAuthSchema(namespace: string) {
  const schema = pgSchema(namespace);

  const user = schema.table("user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
    username: text("username").unique(),
    displayUsername: text("displayUsername"),
    twoFactorEnabled: boolean("twoFactorEnabled").default(false),
    phoneNumber: text("phoneNumber").unique(),
    phoneNumberVerified: boolean("phoneNumberVerified"),
    suspended: boolean("suspended").notNull().default(false),
  });

  const session = schema.table("session", {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
    locked: boolean("locked").notNull().default(false),
    pinHash: text("pinHash"),
    pinFailures: integer("pinFailures").notNull().default(0),
  });

  const account = schema.table("account", {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    legacyPasswordMd5: text("legacyPasswordMd5"),
    legacyPasswordUpgradedAt: timestamp("legacyPasswordUpgradedAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  });

  const verification = schema.table("verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  });

  const twoFactor = schema.table("twoFactor", {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backupCodes").notNull(),
    userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failedVerificationCount").notNull().default(0),
    lockedUntil: timestamp("lockedUntil", { withTimezone: true }),
  });

  return { user, session, account, verification, twoFactor };
}

export type AuthSchema = ReturnType<typeof createAuthSchema>;
