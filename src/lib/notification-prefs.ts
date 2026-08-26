/**
 * Notification preferences — read, and write-through with an optimistic cache.
 *
 * The row may not exist: it is created the first time a player changes anything,
 * not at sign-up, so the defaults live in two places by necessity — here, and as
 * column defaults in the migration, which is what the fan-out trigger reads for a
 * player who has never opened Settings. Keep the two in step.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type NotificationPrefs = {
  // Channels
  email_enabled: boolean;
  push_enabled: boolean;
  // Player categories
  reminders_enabled: boolean;
  bookings_enabled: boolean;
  // Shared by both roles
  messages_enabled: boolean;
  payments_enabled: boolean;
  // Tenant categories
  new_bookings_enabled: boolean;
  booking_changes_enabled: boolean;
  cancellations_enabled: boolean;
  refunds_enabled: boolean;
};

/** Must match the column DEFAULTs in the migrations — `fan_out_notification()` reads
 *  those for a user who has never opened Settings, and these for one whose row has
 *  not loaded yet. If the two disagree, delivery changes the moment a row is created. */
export const DEFAULT_PREFS: NotificationPrefs = {
  email_enabled: true,
  push_enabled: false,
  reminders_enabled: true,
  bookings_enabled: true,
  messages_enabled: true,
  payments_enabled: true,
  new_bookings_enabled: true,
  booking_changes_enabled: true,
  cancellations_enabled: true,
  refunds_enabled: true,
};

/* A literal, not `Object.keys(DEFAULT_PREFS)`: supabase-js parses this string at the
   type level to infer the row shape, and a computed value degrades it to `unknown`.
   The check below is what keeps it honest against DEFAULT_PREFS. */
const PREF_COLUMNS =
  "email_enabled, push_enabled, reminders_enabled, bookings_enabled, messages_enabled, payments_enabled, new_bookings_enabled, booking_changes_enabled, cancellations_enabled, refunds_enabled";

/** Fails the build if a preference is added to the type but not to the select. */
const _PREF_COLUMNS_COVER_ALL: Record<keyof NotificationPrefs, true> = Object.fromEntries(
  PREF_COLUMNS.split(", ").map((c) => [c, true]),
) as Record<keyof NotificationPrefs, true>;
void _PREF_COLUMNS_COVER_ALL;

export const prefsKey = (userId: string | undefined) => ["notification-prefs", userId];

export function useNotificationPrefs(userId: string | undefined) {
  return useQuery({
    queryKey: prefsKey(userId),
    enabled: !!userId,
    queryFn: async (): Promise<NotificationPrefs> => {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select(PREF_COLUMNS)
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      return data ?? DEFAULT_PREFS;
    },
  });
}

export function useUpdateNotificationPrefs(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<NotificationPrefs>) => {
      if (!userId) throw new Error("Not signed in");
      const current = qc.getQueryData<NotificationPrefs>(prefsKey(userId)) ?? DEFAULT_PREFS;
      const { error } = await supabase
        .from("notification_preferences")
        .upsert(
          { user_id: userId, ...current, ...patch, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        );
      if (error) throw error;
    },
    /* A switch that waits for the network reads as broken, so move it now and put it
       back if the write fails. */
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: prefsKey(userId) });
      const previous = qc.getQueryData<NotificationPrefs>(prefsKey(userId));
      qc.setQueryData<NotificationPrefs>(prefsKey(userId), {
        ...(previous ?? DEFAULT_PREFS),
        ...patch,
      });
      return { previous };
    },
    onError: (_e, _patch, context) => {
      if (context?.previous) qc.setQueryData(prefsKey(userId), context.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: prefsKey(userId) });
    },
  });
}
