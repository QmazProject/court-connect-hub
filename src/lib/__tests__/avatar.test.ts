/**
 * Avatar path scoping and upload validation.
 *
 * The path is the access control: every storage policy on the `avatars` bucket checks
 * `(storage.foldername(name))[1] = auth.uid()`. These tests pin the client half of
 * that contract — that the first segment is always the owner's uid and cannot be
 * escaped by a hostile filename. The policy itself is enforced by Postgres and is
 * covered by the SQL suite, not here.
 */

import { describe, expect, it } from "vitest";
import {
  ALLOWED_AVATAR_TYPES,
  MAX_AVATAR_BYTES,
  avatarObjectPath,
  initialsOf,
  validateAvatarFile,
} from "@/lib/avatar";

const UID_A = "11111111-1111-4111-8111-111111111111";
const UID_B = "22222222-2222-4222-8222-222222222222";

describe("avatarObjectPath", () => {
  it("puts the object in a folder named for the owner", () => {
    const path = avatarObjectPath(UID_A, "me.png", "abc123");
    expect(path.split("/")[0]).toBe(UID_A);
    expect(path).toBe(`${UID_A}/abc123.png`);
  });

  it("gives two staff accounts separate folders", () => {
    const a = avatarObjectPath(UID_A, "a.png", "x");
    const b = avatarObjectPath(UID_B, "b.png", "y");
    expect(a.split("/")[0]).not.toBe(b.split("/")[0]);
  });

  it("cannot be escaped by a traversing or hostile filename", () => {
    // The extension is the only part taken from user input, and it is stripped to
    // [a-z0-9] — so no separator, traversal or nesting can reach the path.
    for (const name of ["../../other-user/avatar.png", "x.png/../../evil", "a.PN/G", "b."]) {
      const path = avatarObjectPath(UID_A, name, "u1");
      expect(path.split("/")).toHaveLength(2);
      expect(path.startsWith(`${UID_A}/`)).toBe(true);
      expect(path).not.toContain("..");
    }
  });

  it("falls back to a sane extension when there is none", () => {
    expect(avatarObjectPath(UID_A, "noextension", "u1")).toBe(`${UID_A}/u1.jpg`);
  });

  it("uses a fresh object name per upload so a replacement is never cache-stale", () => {
    const first = avatarObjectPath(UID_A, "me.png", "u1");
    const second = avatarObjectPath(UID_A, "me.png", "u2");
    expect(first).not.toBe(second);
  });
});

describe("validateAvatarFile", () => {
  it("accepts the allowed image types", () => {
    for (const type of ALLOWED_AVATAR_TYPES) {
      expect(validateAvatarFile({ type, size: 1024 })).toBeNull();
    }
  });

  it("rejects non-images, including ones merely claiming to be", () => {
    expect(validateAvatarFile({ type: "application/pdf", size: 10 })).toBeTruthy();
    expect(validateAvatarFile({ type: "text/html", size: 10 })).toBeTruthy();
    expect(validateAvatarFile({ type: "image/svg+xml", size: 10 })).toBeTruthy();
    expect(validateAvatarFile({ type: "", size: 10 })).toBeTruthy();
  });

  it("rejects anything over the size cap", () => {
    expect(validateAvatarFile({ type: "image/png", size: MAX_AVATAR_BYTES })).toBeNull();
    expect(validateAvatarFile({ type: "image/png", size: MAX_AVATAR_BYTES + 1 })).toBeTruthy();
  });
});

describe("initialsOf — the fallback when there is no picture", () => {
  it("uses first and last initials", () => {
    expect(initialsOf("Jude Martinez")).toBe("JM");
    expect(initialsOf("Ana Maria Cruz")).toBe("AC");
  });

  it("handles a single name", () => {
    expect(initialsOf("Jude")).toBe("JU");
  });

  it("falls back per role when there is no name at all", () => {
    expect(initialsOf("", "V")).toBe("V");
    expect(initialsOf(null, "P")).toBe("P");
    expect(initialsOf("   ", "V")).toBe("V");
  });
});
