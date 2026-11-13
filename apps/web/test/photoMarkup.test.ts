/**
 * Photos drawn on, as they're stored (lib/photoMarkup.ts): the drawing is a new file beside the
 * photo, never the photo itself; screens show the drawing with a link to the original; saving
 * uploads it and then points the photo's row at it, and takes the file back off when the row
 * can't take it; taking the drawing off leaves the original.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  files: new Map<string, number>(),
  rows: new Map<string, { id: string; path: string; marked_path: string | null }>(),
  removed: [] as string[],
  /** The row isn't the person's to change (attachments_update). */
  refuse: false,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/lib/api", () => ({
  unwrap: (r: { data: unknown; error: { message: string } | null }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  },
  supabase: () => ({
    storage: {
      from: () => ({
        upload: async (path: string, body: Blob) => {
          server.files.set(path, body.size);
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          server.removed.push(...paths);
          paths.forEach((p) => server.files.delete(p));
          return { data: null, error: null };
        },
        download: async (path: string) => (server.files.has(path) ? { data: new Blob([new Uint8Array(server.files.get(path)!)]), error: null } : { data: null, error: { message: "Object not found" } }),
        createSignedUrls: async (paths: string[]) => ({ data: paths.filter((p) => server.files.has(p)).map((p) => ({ path: p, signedUrl: `https://files.test/${p}?token=1` })), error: null }),
      }),
    },
    from: () => ({
      update: (values: Record<string, unknown>) => ({
        eq: (_k: string, id: string) => ({
          select: async () => {
            server.updates.push(values);
            const row = server.rows.get(id);
            if (!row || server.refuse) return { data: [], error: null };
            Object.assign(row, values);
            return { data: [{ id }], error: null };
          },
        }),
      }),
    }),
  }),
}));

const { markedPathFor, photoLinks, photoPaths, photoPicture, removeMarkup, saveMarkup, shownPath } = await import("../src/lib/photoMarkup");

const ORIGINAL = "c1/visit/v1/aa000000-0000-0000-0000-000000000001.jpg";
beforeEach(() => {
  server.files.clear();
  server.rows.clear();
  server.removed = [];
  server.updates = [];
  server.refuse = false;
  server.files.set(ORIGINAL, 3000);
  server.rows.set("p1", { id: "p1", path: ORIGINAL, marked_path: null });
});

describe("where a drawing is kept", () => {
  it("is a new file in the photo's own folder, never the photo itself, a new name each time", () => {
    const first = markedPathFor(ORIGINAL);
    expect(first).toMatch(/^c1\/visit\/v1\/[0-9a-f-]{36}\.jpg$/);
    expect(first).not.toBe(ORIGINAL);
    expect(markedPathFor(ORIGINAL)).not.toBe(first);
    // A client's file merged from another client stays in that client's folder, and so does its drawing.
    expect(markedPathFor("c1/client/old/x.png")).toMatch(/^c1\/client\/old\/[0-9a-f-]{36}\.jpg$/);
  });
});

describe("what a photo shows", () => {
  it("is its drawing when it has one, else the photo as taken", () => {
    expect(shownPath({ path: ORIGINAL, marked_path: null })).toBe(ORIGINAL);
    expect(shownPath({ path: ORIGINAL })).toBe(ORIGINAL);
    expect(shownPath({ path: ORIGINAL, marked_path: "c1/visit/v1/m.jpg" })).toBe("c1/visit/v1/m.jpg");
  });

  it("links both, in one round, each file once", async () => {
    server.files.set("c1/visit/v1/m.jpg", 2000);
    expect(photoPaths([{ path: "a" }, { path: "b", marked_path: "m" }, { path: "a" }])).toEqual(["a", "b", "m"]);
    const [plain, drawn] = await photoLinks([{ path: ORIGINAL, marked_path: null, id: "p1" }, { path: ORIGINAL, marked_path: "c1/visit/v1/m.jpg", id: "p2" }]);
    expect(plain).toEqual({ id: "p1", path: ORIGINAL, marked_path: null, url: `https://files.test/${ORIGINAL}?token=1`, originalUrl: `https://files.test/${ORIGINAL}?token=1` });
    expect(drawn!.url).toBe("https://files.test/c1/visit/v1/m.jpg?token=1");
    expect(drawn!.originalUrl).toBe(`https://files.test/${ORIGINAL}?token=1`);
  });

  it("falls back to the photo as taken when its drawing can't be found", async () => {
    const [p] = await photoLinks([{ path: ORIGINAL, marked_path: "c1/visit/v1/gone.jpg" }]);
    expect(p!.url).toBe(`https://files.test/${ORIGINAL}?token=1`);
  });
});

describe("saving a drawing on a photo that's up", () => {
  it("uploads it beside the photo and points the photo at it, leaving the photo as it was", async () => {
    const path = await saveMarkup({ id: "p1", path: ORIGINAL }, new Blob([new Uint8Array(1200)], { type: "image/jpeg" }));
    expect(server.rows.get("p1")).toEqual({ id: "p1", path: ORIGINAL, marked_path: path });
    expect(server.files.get(path)).toBe(1200);
    expect(server.files.get(ORIGINAL)).toBe(3000);
  });

  it("takes the file back off when the photo isn't theirs to change, and says why", async () => {
    server.refuse = true;
    await expect(saveMarkup({ id: "p1", path: ORIGINAL }, new Blob(["x"]))).rejects.toThrow("You can draw on photos you added. Ask the office to draw on this one.");
    expect(server.removed).toHaveLength(1);
    expect([...server.files.keys()]).toEqual([ORIGINAL]);
    expect(server.rows.get("p1")!.marked_path).toBeNull();
  });

  it("opens the photo to draw on as the person, and says plainly when it can't", async () => {
    expect((await photoPicture(ORIGINAL)).size).toBe(3000);
    await expect(photoPicture("c1/visit/v1/missing.jpg")).rejects.toThrow("This photo couldn't be opened. Check your signal and try again.");
  });
});

describe("taking a drawing off", () => {
  it("points the photo back at the original (the database puts the drawing in the Trash)", async () => {
    server.rows.get("p1")!.marked_path = "c1/visit/v1/m.jpg";
    await removeMarkup({ id: "p1" });
    expect(server.rows.get("p1")!.marked_path).toBeNull();
    expect(server.updates).toEqual([{ marked_path: null }]);
  });

  it("says so when the photo isn't theirs to change", async () => {
    server.refuse = true;
    await expect(removeMarkup({ id: "p1" })).rejects.toThrow("You can change photos you added.");
  });
});
