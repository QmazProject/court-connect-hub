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
  email_enabled: boolean;
  push_enabled: boolean;
  reminders_enabled: boolean;
  bookings_enabled: boolean;
  messages_enabled: boolean;
  payments_enabled: boolean;
};

export const DEFAULT_PREFS: NotificationPrefs = {
  email_enabled: true,
  push_enabled: false,
  reminders_enabled: true,
  bookings_enabled: true,
  messages_enabled: true,
  payments_enabled: true,
};

export const prefsKey = (userId: string | undefined) => ["notification-prefs", userId];

export function useNotificationPrefs(userId: string | undefined) {
  return useQuery({
    queryKey: prefsKey(userId),
    enabled: !!userId,
    queryFn: async (): Promise<NotificationPrefs> => {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select(
          "email_enabled, push_enabled, reminders_enabled, bookings_enabled, messages_enabled, payments_enabled",
        )
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
