/**
 * Profile picture upload.
 *
 * The file goes to `avatars/{uid}/…` and the row stores a signed URL, matching how
 * venue images already work here rather than adding a public bucket as a second
 * convention. The uid folder is not decoration: every storage policy on this bucket
 * checks `(storage.foldername(name))[1] = auth.uid()`, so the path is the access
 * control.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const BUCKET = "avatars";
/** Matches ImageUploader. A signed URL that expires would blank an avatar that is
 *  still perfectly valid, and there is no job here to re-sign them. */
const SIGNED_EXPIRY = 60 * 60 * 24 * 365 * 10;

export const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

/** What the bucket will accept. Narrow on purpose: the avatars bucket must not become
 *  a general file drop, and the storage policies scope *who* can write, not *what*. */
export const ALLOWED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Where one user's avatar object lives.
 *
 * The first path segment is the owner's uid, and every storage policy on this bucket
 * checks `(storage.foldername(name))[1] = auth.uid()`, so the path *is* the access
 * control. Exported so that rule can be asserted in a test rather than only existing
 * inside a mutation.
 *
 * A fresh name per upload rather than a fixed `avatar.jpg`: the previous signed URL
 * stays valid until the profile row is updated, so the picture never flashes empty,
 * and no CDN holds a stale copy under a reused name.
 */
export function avatarObjectPath(userId: string, fileName: string, unique: string): string {
  /* `split(".").pop()` returns the whole string when there is no dot, which turned a
     file called "photo" into "photo.photo". Take the extension only when one exists,
     then strip it to [a-z0-9] so no separator or traversal can reach the path. */
  const dot = fileName.lastIndexOf(".");
  const raw = dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1) : "";
  const ext = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${userId}/${unique}.${ext || "jpg"}`;
}

/** Shared by the hook and its test, so the two cannot disagree about what is allowed. */
export function validateAvatarFile(file: { type: string; size: number }): string | null {
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    return "Pick a PNG, JPG, WebP or GIF image.";
  }
  if (file.size > MAX_AVATAR_BYTES) return "Pick an image under 3 MB.";
  return null;
}

export function useAvatarUpload(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (!userId) throw new Error("Not signed in");
      const invalid = validateAvatarFile(file);
      if (invalid) throw new Error(invalid);

      const path = avatarObjectPath(
        userId,
        file.name,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );

      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
      if (upErr) throw upErr;

      const { data: signed, error: sErr } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(path, SIGNED_EXPIRY);
      if (sErr) throw sErr;

      const { error: profErr } = await supabase
        .from("profiles")
        .update({ avatar_url: signed.signedUrl })
        .eq("id", userId);
      if (profErr) throw profErr;

      return signed.signedUrl;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile", userId] });
      qc.invalidateQueries({ queryKey: ["auth-player-session"] });
    },
  });
}

export function useRemoveAvatar(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase
        .from("profiles")
        .update({ avatar_url: null })
        .eq("id", userId);
      if (error) throw error;
      /* The object itself is left in the bucket. Removing it would need the storage
         path, which the signed URL does not cleanly give back, and an orphaned file
         behind a uid-scoped policy is cheap. Worth a cleanup job if it ever matters. */
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile", userId] });
      qc.invalidateQueries({ queryKey: ["auth-player-session"] });
    },
  });
}

/** Initials for the fallback tile, so a player without a picture still gets
 *  something that identifies them rather than a generic silhouette. */
export function initialsOf(name: string | null | undefined, fallback = "P"): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
