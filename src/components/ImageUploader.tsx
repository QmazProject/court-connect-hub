import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const BUCKET = "venue-images";
const SIGNED_EXPIRY = 60 * 60 * 24 * 365 * 10; // 10 years

type Props = {
  label?: string;
  pathPrefix: string; // e.g. `venues/${venueId}` or `courts/new-${Date.now()}`
  images: string[];
  onChange: (next: string[]) => void;
  max?: number;
};

export function ImageUploader({ label = "Photos", pathPrefix, images, onChange, max = 8 }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setErr(null);
    setBusy(true);
    try {
      const remaining = Math.max(0, max - images.length);
      const list = Array.from(files).slice(0, remaining);
      const uploaded: string[] = [];
      for (const file of list) {
        if (!file.type.startsWith("image/")) throw new Error(`"${file.name}" is not an image.`);
        if (file.size > 5 * 1024 * 1024) throw new Error(`"${file.name}" is larger than 5 MB.`);
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const path = `${pathPrefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
          cacheControl: "3600",
          upsert: false,
          contentType: file.type,
        });
        if (upErr) throw upErr;
        const { data: signed, error: sErr } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_EXPIRY);
        if (sErr) throw sErr;
        uploaded.push(signed.signedUrl);
      }
      onChange([...images, ...uploaded]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = (idx: number) => {
    onChange(images.filter((_, i) => i !== idx));
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground">{images.length}/{max}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {images.map((src, i) => (
          <div key={i} className="relative h-20 w-28 overflow-hidden rounded-md border border-border">
            <img src={src} alt={`Upload ${i + 1}`} className="h-full w-full object-cover" loading="lazy" />
            <button
              type="button"
              onClick={() => remove(i)}
              className="absolute right-1 top-1 rounded-full bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold text-destructive shadow hover:bg-background"
              aria-label="Remove image"
            >
              ✕
            </button>
          </div>
        ))}
        {images.length < max && (
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="grid h-20 w-28 place-items-center rounded-md border-2 border-dashed border-border text-xs text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-60"
          >
            {busy ? "Uploading…" : "+ Upload"}
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <p className="mt-1 text-[11px] text-muted-foreground">JPG/PNG/WebP up to 5 MB each.</p>
      {err && <p className="mt-1 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{err}</p>}
    </div>
  );
}
