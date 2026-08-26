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

export function useAvatarUpload(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (!userId) throw new Error("Not signed in");
      if (!file.type.startsWith("image/")) throw new Error("That file is not an image.");
      if (file.size > MAX_AVATAR_BYTES) throw new Error("Pick an image under 3 MB.");

      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      /* A new path per upload rather than a fixed `avatar.jpg`: the old signed URL
         stays valid until the row is updated, so the picture never flashes empty,
         and no CDN holds a stale copy under a reused name. */
      const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

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
