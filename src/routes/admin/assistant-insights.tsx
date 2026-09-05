/**
 * What people asked that CourtHub could not answer.
 *
 * Every number here is a count of rows that exist. There is deliberately no
 * "resolution rate": only misses are recorded, so the denominator — every answer
 * the assistant gave — is unknown, and a percentage computed from what is stored
 * would be invented. The cards say "logged signals" because that is what they are.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invalidateAssistantMappings } from "@/lib/assistant/vocabulary";

export const Route = createFileRoute("/admin/assistant-insights")({
  ssr: false,
  component: AssistantInsights,
});

const WINDOWS = [
  { key: "1", label: "Today", days: 1 },
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "all", label: "All time", days: null },
] as const;

const CATEGORY_LABEL: Record<string, string> = {
  unknown_intent: "Unknown question",
  unsupported_question: "Unsupported question",
  zero_inventory: "Nothing offered",
  no_available_slots: "Fully booked",
  zero_results: "Zero results",
  unknown_sport_term: "Unknown sport",
  unknown_amenity_term: "Unknown amenity",
  ambiguous_venue: "Ambiguous venue",
  ambiguous_court: "Ambiguous court",
  location_not_found: "Location not found",
  missing_venue_data: "Missing venue data",
  missing_policy_data: "Missing policy data",
  missing_payment_data: "Missing payment data",
};

const PAGE = 20;

function AssistantInsights() {
  const qc = useQueryClient();
  const [win, setWin] = useState<(typeof WINDOWS)[number]["key"]>("30");
  const [category, setCategory] = useState<string>("all");
  const [status, setStatus] = useState<string>("open");
  const [page, setPage] = useState(0);

  const since = useMemo(() => {
    const days = WINDOWS.find((w) => w.key === win)?.days ?? null;
    return days == null ? null : new Date(Date.now() - days * 86_400_000).toISOString();
  }, [win]);

  const statsQ = useQuery({
    queryKey: ["admin-insight-stats", since],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("admin_assistant_insight_stats", {
        _since: since,
      });
      if (error) throw error;
      return data ?? [];
    },
  });

  /* Filtering and paging happen in the database. The browser never holds the whole
     analytics table. */
  const listQ = useQuery({
    queryKey: ["admin-insight-list", since, category, status, page],
    queryFn: async () => {
      let q = supabase
        .from("assistant_query_feedback")
        .select(
          "id, category, normalized_query, display_query, role, sport_term, amenity_term, location_term, occurrence_count, first_seen_at, last_seen_at, status, admin_notes",
          { count: "exact" },
        )
        .order("occurrence_count", { ascending: false })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (since) q = q.gte("last_seen_at", since);
      if (category !== "all") q = q.eq("category", category);
      if (status !== "all") q = q.eq("status", status);
      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });

  const demandQ = useQuery({
    queryKey: ["admin-insight-demand", since],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("admin_assistant_demand", {
        _since: since,
        _limit: 10,
      });
      if (error) throw error;
      return data ?? [];
    },
  });

  const review = useMutation({
    mutationFn: async (args: { id: number; status: string; notes?: string }) => {
      const { error } = await supabase.rpc("admin_review_assistant_feedback", {
        _id: args.id,
        _status: args.status,
        _notes: args.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-insight-list"] });
      void qc.invalidateQueries({ queryKey: ["admin-insight-stats"] });
    },
  });

  const map = useMutation({
    mutationFn: async (args: {
      kind: string;
      term: string;
      target: string;
      feedbackId: number;
    }) => {
      const { error } = await supabase.rpc("admin_upsert_assistant_mapping", {
        _kind: args.kind,
        _term: args.term,
        _target_value: args.target,
        _feedback_id: args.feedbackId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      /* The admin's own next question should use the mapping immediately. */
      invalidateAssistantMappings();
      void qc.invalidateQueries({ queryKey: ["admin-insight-list"] });
    },
  });

  const totals = useMemo(() => {
    const rows = statsQ.data ?? [];
    const by = (pred: (c: string) => boolean) =>
      rows.filter((r) => pred(r.category)).reduce((n, r) => n + Number(r.occurrences), 0);
    return {
      all: rows.reduce((n, r) => n + Number(r.occurrences), 0),
      unknown: by((c) => c === "unknown_intent" || c === "unsupported_question"),
      vocabulary: by((c) => c === "unknown_sport_term" || c === "unknown_amenity_term"),
      empty: by(
        (c) => c === "zero_results" || c === "zero_inventory" || c === "no_available_slots",
      ),
      location: by((c) => c === "location_not_found"),
      open: rows.filter((r) => r.status === "open").reduce((n, r) => n + Number(r.signals), 0),
    };
  }, [statsQ.data]);

  const rows = listQ.data?.rows ?? [];
  const total = listQ.data?.total ?? 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-6 sm:px-8">
      <h1 className="font-display text-2xl font-semibold text-foreground">Assistant Insights</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Questions the assistant could not answer. These are logged misses, not a share of all
        conversations — successful answers are not recorded, so no success rate can be shown.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            onClick={() => {
              setWin(w.key);
              setPage(0);
            }}
            className={
              "rounded-full px-3 py-1 text-xs font-semibold transition " +
              (win === w.key
                ? "bg-foreground text-popover"
                : "border border-border text-muted-foreground hover:bg-secondary")
            }
          >
            {w.label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Card label="Logged signals" value={totals.all} hint="occurrences in window" />
        <Card label="Not understood" value={totals.unknown} hint="unknown or unsupported" />
        <Card label="Vocabulary gaps" value={totals.vocabulary} hint="sport or amenity words" />
        <Card label="Found nothing" value={totals.empty} hint="zero results or fully booked" />
        <Card label="Open items" value={totals.open} hint="awaiting review" />
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <Select
          value={category}
          onChange={(v) => {
            setCategory(v);
            setPage(0);
          }}
          options={[["all", "All categories"], ...Object.entries(CATEGORY_LABEL)]}
        />
        <Select
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(0);
          }}
          options={[
            ["open", "Open"],
            ["reviewed", "Reviewed"],
            ["ignored", "Ignored"],
            ["product_gap", "Product gap"],
            ["resolved", "Resolved"],
            ["all", "Any status"],
          ]}
        />
      </div>

      <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-secondary/60 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Query / term</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Count</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Last seen</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {listQ.isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-muted-foreground">
                  Nothing logged in this window. That is a good sign, not a broken page.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <span className="font-medium text-foreground">
                      {r.sport_term || r.amenity_term || r.display_query || r.normalized_query}
                    </span>
                    {(r.location_term || r.sport_term) && (
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        {[r.sport_term, r.location_term].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {CATEGORY_LABEL[r.category] ?? r.category}
                  </td>
                  <td className="px-3 py-2 font-semibold">{r.occurrence_count}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.role}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(r.last_seen_at).toLocaleDateString("en-PH")}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Act onClick={() => review.mutate({ id: r.id, status: "reviewed" })}>
                        Reviewed
                      </Act>
                      <Act onClick={() => review.mutate({ id: r.id, status: "ignored" })}>
                        Ignore
                      </Act>
                      <Act onClick={() => review.mutate({ id: r.id, status: "product_gap" })}>
                        Product gap
                      </Act>
                      {(r.sport_term || r.amenity_term) && (
                        <Act
                          onClick={() => {
                            const kind = r.sport_term ? "sport_alias" : "amenity_alias";
                            const term = (r.sport_term || r.amenity_term) as string;
                            const target = window.prompt(
                              `Map "${term}" to which existing CourtHub ${r.sport_term ? "sport" : "amenity"}?`,
                            );
                            if (target && target.trim()) {
                              map.mutate({ kind, term, target: target.trim(), feedbackId: r.id });
                            }
                          }}
                        >
                          Map…
                        </Act>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total === 0
            ? "No rows"
            : `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, total)} of ${total}`}
        </span>
        <div className="flex gap-2">
          <Act onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Act>
          <Act onClick={() => setPage((p) => ((p + 1) * PAGE < total ? p + 1 : p))}>Next</Act>
        </div>
      </div>

      <h2 className="mt-8 font-display text-lg font-semibold text-foreground">
        Unmet CourtHub searches
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Places and sports people searched for and found nothing. This is search behaviour, not
        proven commercial demand.
      </p>
      <ul className="mt-3 space-y-2">
        {(demandQ.data ?? []).length === 0 ? (
          <li className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            Nothing recorded yet.
          </li>
        ) : (
          (demandQ.data ?? []).map((d, i) => (
            <li key={i} className="rounded-lg border border-border bg-card px-4 py-3">
              <p className="text-sm font-semibold text-foreground">
                {[d.sport_term, d.location_term].filter(Boolean).join(" in ") || "Unspecified"}
              </p>
              <p className="text-xs text-muted-foreground">
                {d.searches} search{Number(d.searches) === 1 ? "" : "es"} with no match
              </p>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold text-foreground">{value}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

function Act({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-semibold text-foreground transition hover:bg-secondary"
    >
      {children}
    </button>
  );
}
