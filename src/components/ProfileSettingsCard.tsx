/**
 * Profile picture and display name, for either role.
 *
 * Shared for the same reason as the avatar itself: the picture belongs to the signed-in
 * account, not to what that account is allowed to do. A venue manager and a player use
 * the same `avatars` bucket, the same `auth.uid()`-scoped path and the same validation.
 * Nothing here touches venue imagery.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Loader2, Trash2, User as UserIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { initialsOf, useAvatarUpload, useRemoveAvatar } from "@/lib/avatar";

export function ProfileSettingsCard({
  userId,
  fullName,
  email,
  avatarUrl,
  role,
  onSaved,
}: {
  userId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  role: "player" | "tenant";
  /** Lets the host invalidate whatever else it keys off the profile. */
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(fullName);
  const [nameSaved, setNameSaved] = useState(false);
  const [avatarErr, setAvatarErr] = useState<string | null>(null);

  /* `fullName` arrives once the profile query settles, usually after first render. */
  useEffect(() => setName(fullName), [fullName]);

  const upload = useAvatarUpload(userId);
  const removeAvatar = useRemoveAvatar(userId);

  const saveName = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: name.trim() })
        .eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      setNameSaved(true);
      /* The sidebar reads the profile query, so invalidating here is what makes the
         new picture and name appear beside it without a reload or a sign-out. */
      qc.invalidateQueries({ queryKey: ["profile", userId] });
      qc.invalidateQueries({ queryKey: ["auth-player-session"] });
      onSaved?.();
      setTimeout(() => setNameSaved(false), 2500);
    },
  });

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setAvatarErr(null);
    try {
      await upload.mutateAsync(file);
      onSaved?.();
    } catch (e) {
      setAvatarErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      // Clear the input so picking the SAME file again still fires a change event.
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const fallback = role === "tenant" ? "V" : "P";
  const initials = initialsOf(name || fullName, fallback);

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <UserIcon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-base font-bold tracking-tight">Profile</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {role === "tenant"
              ? "Your own picture and name. This is not your venue's logo."
              : "Your picture and name, shown across CourtHub."}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-5">
        <div className="relative">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className="h-20 w-20 rounded-full border-2 border-border object-cover"
            />
          ) : (
            <span className="grid h-20 w-20 place-items-center rounded-full border-2 border-border bg-secondary font-display text-xl font-bold text-muted-foreground">
              {initials}
            </span>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
            aria-label="Change profile picture"
            className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full border-2 border-card bg-primary text-primary-foreground shadow transition hover:opacity-90 disabled:opacity-50"
          >
            {upload.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="min-w-0 flex-1">
          <input
            ref={fileRef}
            type="file"
            /* Narrow on purpose. The bucket must not become a general file drop, and
               the mutation re-checks the MIME type and size before uploading. */
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={upload.isPending}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold transition hover:border-primary disabled:opacity-50"
            >
              {avatarUrl ? "Change picture" : "Upload picture"}
            </button>
            {avatarUrl && (
              <button
                type="button"
                onClick={() => removeAvatar.mutate(undefined, { onSuccess: () => onSaved?.() })}
                disabled={removeAvatar.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">JPG, PNG or WebP, up to 3 MB.</p>
          {avatarErr && <p className="mt-2 text-xs font-medium text-destructive">{avatarErr}</p>}
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Full name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your full name"
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Email</span>
          <input
            value={email}
            readOnly
            className="mt-1 w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
          />
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => saveName.mutate()}
          disabled={saveName.isPending || name.trim() === fullName.trim()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {saveName.isPending ? "Saving…" : "Save changes"}
        </button>
        {nameSaved && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
        {saveName.isError && (
          <span className="text-xs font-medium text-destructive">
            {saveName.error instanceof Error ? saveName.error.message : "Could not save."}
          </span>
        )}
      </div>
    </section>
  );
}
