/**
 * Player Settings — who you are, and how CourtHub is allowed to reach you.
 *
 * Both halves are shared with the tenant workspace. The profile picture belongs to an
 * account rather than a role, and the notification channels are identical for both;
 * only the notification *category* list differs, which that card decides itself.
 */

import { ProfileSettingsCard } from "@/components/ProfileSettingsCard";
import { NotificationSettingsCard } from "@/components/NotificationSettingsCard";

export function PlayerSettingsView({
  userId,
  fullName,
  email,
  avatarUrl,
}: {
  userId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
          Player workspace
        </p>
        <h1 className="mt-1 font-cabinet text-2xl font-bold tracking-tight sm:text-3xl">
          Settings
        </h1>
      </div>

      <ProfileSettingsCard
        userId={userId}
        fullName={fullName}
        email={email}
        avatarUrl={avatarUrl}
        role="player"
      />

      <NotificationSettingsCard userId={userId} email={email} role="player" />
    </div>
  );
}
