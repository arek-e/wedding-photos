import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const guests = sqliteTable(
  "guests",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    phoneIdx: uniqueIndex("guests_phone_idx").on(table.phone),
  }),
);

export const photos = sqliteTable("photos", {
  id: text("id").primaryKey(),
  guestId: text("guest_id")
    .notNull()
    .references(() => guests.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type Guest = typeof guests.$inferSelect;
export type Photo = typeof photos.$inferSelect;
