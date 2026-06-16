"use client";

import * as React from "react";
import { Loader2, UploadCloud, X, ImagePlus } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface UploadedImage {
  id: string;
  url: string;
  key: string;
}

interface Props {
  ownerType: string;
  ownerId?: string;
  value: UploadedImage[];
  onChange: (next: UploadedImage[]) => void;
  max?: number;
  className?: string;
}

export function ImageUploader({
  ownerType,
  ownerId,
  value,
  onChange,
  max = 6,
  className,
}: Props) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remaining = max - value.length;
    if (remaining <= 0) {
      toast.error(`You can upload at most ${max} images.`);
      return;
    }
    const list = Array.from(files).slice(0, remaining);
    setBusy(true);
    try {
      const uploaded: UploadedImage[] = [];
      for (const f of list) {
        const u = await api.uploadImage(f, ownerType, ownerId);
        uploaded.push({ id: u.id, url: u.url, key: u.key });
      }
      onChange([...value, ...uploaded]);
      toast.success(
        `Uploaded ${uploaded.length} image${uploaded.length === 1 ? "" : "s"}`,
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error(`Upload failed: ${msg}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function remove(id: string) {
    onChange(value.filter((v) => v.id !== id));
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed bg-card p-8 text-center transition",
          dragging
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/40",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <div className="grid h-12 w-12 place-items-center rounded-full bg-secondary text-primary">
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <UploadCloud className="h-5 w-5" />
          )}
        </div>
        <p className="text-sm font-medium">
          {busy ? "Uploading…" : "Drag & drop images here, or"}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          <ImagePlus className="h-4 w-4" /> Choose files
        </Button>
        <p className="text-xs text-muted-foreground">
          JPG, PNG, WebP, GIF, AVIF · up to 5MB · {value.length}/{max} used
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          multiple
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {value.length > 0 && (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {value.map((img) => (
            <li
              key={img.id}
              className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-muted"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => remove(img.id)}
                className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100"
                aria-label="Remove image"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
