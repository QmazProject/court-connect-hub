/**
 * The trusted vocabulary an admin has approved.
 *
 * These rows are the only way a word that CourtHub's own data does not contain can
 * come to mean something. Nothing a user types reaches this table; a mapping exists
 * because a person read a real miss and decided. Deactivation is preferred over
 * deletion so the audit trail stays intact.
 *
 * Mappings are data, never code: the term is matched literally after normalisation,
 * and is not compiled, evaluated, or used as a pattern anywhere.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { invalidateAssistantMappings } from "@/lib/assistant/vocabulary";

export const Route = createFileRoute("/admin/assistant-mappings")({
  ssr: false,
  component: AssistantMappings,
});

function AssistantMappings() {
  const qc = useQueryClient();
  const [kind, setKind] = useState("sport_alias");
  const [term, setTerm] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: ["admin-mappings"],
    queryFn: async () => {
      const { data, error: e } = await supabase
        .from("assistant_term_mappings")
        .select("id, kind, term, normalized_term, target_value, active, created_at, updated_at")
        .order("updated_at", { ascending: false })
        .limit(200);
      if (e) throw e;
      return data ?? [];
    },
  });

  const refresh = () => {
    /* The admin's own next assistant question should use the change immediately;
       other sessions pick it up on the short TTL. */
    invalidateAssistantMappings();
    void qc.invalidateQueries({ queryKey: ["admin-mappings"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const { error: e } = await supabase.rpc("admin_upsert_assistant_mapping", {
        _kind: kind,
        _term: term.trim(),
        _target_value: target.trim(),
      });
      if (e) throw e;
    },
    onSuccess: () => {
      setTerm("");
      setTarget("");
      setError(null);
      refresh();
    },
    /* The database refuses a target CourtHub does not have. Show that reason rather
       than a generic failure — it is the whole point of the check. */
    onError: (e: unknown) => setError(e instanceof Error ? e.message : "That mapping was refused."),
  });

  const toggle = useMutation({
    mutationFn: async (args: { id: number; active: boolean }) => {
      const { error: e } = await supabase.rpc("admin_set_assistant_mapping_active", {
        _id: args.id,
        _active: args.active,
      });
      if (e) throw e;
    },
    onSuccess: refresh,
  });

  const rows = listQ.data ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-6 sm:px-8">
      <h1 className="font-display text-2xl font-semibold text-foreground">Assistant Mappings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Words the assistant should treat as CourtHub terms. The target must already exist in
        CourtHub data — a mapping cannot invent a sport or an amenity.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (term.trim() && target.trim()) save.mutate();
        }}
        className="mt-5 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4"
      >
        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground">Type</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="mt-1 block rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="sport_alias">Sport alias</option>
            <option value="amenity_alias">Amenity alias</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground">Term people type</span>
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="car park"
            className="mt-1 block rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground">
            Existing CourtHub value
          </span>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Parking"
            className="mt-1 block rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-popover transition hover:opacity-90 disabled:opacity-50"
        >
          Save mapping
        </button>
      </form>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <div className="mt-5 overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-left text-sm">
          <thead className="bg-secondary/60 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Term</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Maps to</th>
              <th className="px-3 py-2">Updated</th>
              <th className="px-3 py-2 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {listQ.isLoading ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-muted-foreground">
                  No mappings yet. CourtHub&apos;s own sport and amenity names already work without
                  one — these are for the words people use instead.
                </td>
              </tr>
            ) : (
              rows.map((m) => (
                <tr key={m.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium text-foreground">{m.term}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {m.kind === "sport_alias" ? "Sport" : "Amenity"}
                  </td>
                  <td className="px-3 py-2">{m.target_value}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(m.updated_at).toLocaleDateString("en-PH")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => toggle.mutate({ id: m.id, active: !m.active })}
                      className={
                        "rounded-md border px-2 py-1 text-[11px] font-semibold transition " +
                        (m.active
                          ? "border-border bg-background text-foreground hover:bg-secondary"
                          : "border-border bg-secondary text-muted-foreground hover:bg-background")
                      }
                    >
                      {m.active ? "Active — deactivate" : "Inactive — reactivate"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
