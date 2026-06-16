"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ImageUploader,
  type UploadedImage,
} from "@/components/image-uploader";
import { CategorySelect } from "@/components/category-select";
import { api } from "@/lib/api";
import type { Product } from "@/lib/types";

interface FormState {
  name: string;
  brand: string;
  price: string;
  discountPercent: string;
  stock: string;
  category: string;
  description: string;
}

export default function EditProductPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [loading, setLoading] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [form, setForm] = React.useState<FormState | null>(null);
  const [images, setImages] = React.useState<UploadedImage[]>([]);

  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .getProduct(id)
      .then((p: Product) => {
        if (cancelled) return;
        setForm({
          name: p.name ?? "",
          brand: p.brand ?? "",
          price: String(p.price ?? ""),
          discountPercent: String(p.discountPercent ?? 0),
          stock: String(p.stock ?? ""),
          category: p.category ?? "",
          description: p.description ?? "",
        });
        // Wrap existing image URLs in the uploader's shape. The id/key
        // are synthesized — they're only used locally for list keys & remove.
        setImages(
          (p.images ?? []).map((url, i) => ({
            id: `existing-${i}-${url}`,
            url,
            key: "",
          })),
        );
      })
      .catch((e: Error) => toast.error(e.message || "Failed to load product"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  function update<K extends keyof FormState>(k: K) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !id) return;
    setSubmitting(true);
    try {
      await api.updateProduct(id, {
        name: form.name,
        brand: form.brand || null,
        price: Number(form.price),
        discountPercent: form.discountPercent ? Number(form.discountPercent) : 0,
        stock: Number(form.stock),
        category: form.category,
        description: form.description,
        images: images.map((i) => i.url),
      });
      toast.success("Product updated");
      router.push("/admin/products");
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message || "Update failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Card className="space-y-3 p-6">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </Card>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="text-center text-muted-foreground">Product not found.</div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-glow">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Edit product
          </h1>
          <p className="text-sm text-muted-foreground">ID #{id}</p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="mb-4 text-lg font-semibold">Images</h2>
            <ImageUploader
              ownerType="product"
              ownerId={id}
              value={images}
              onChange={setImages}
              max={8}
            />
          </Card>

          <Card className="p-6">
            <h2 className="mb-4 text-lg font-semibold">Details</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" required value={form.name} onChange={update("name")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="brand">Brand</Label>
                <Input id="brand" value={form.brand} onChange={update("brand")} />
              </div>
              <CategorySelect
                value={form.category}
                onChange={(v) =>
                  setForm((f) => (f ? { ...f, category: v } : f))
                }
                required
              />
              <div className="space-y-1.5">
                <Label htmlFor="price">Price (NGN)</Label>
                <Input
                  id="price"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={form.price}
                  onChange={update("price")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="discountPercent">Discount %</Label>
                <Input
                  id="discountPercent"
                  type="number"
                  min="0"
                  max="90"
                  step="1"
                  placeholder="0"
                  value={form.discountPercent}
                  onChange={update("discountPercent")}
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank or 0 for no discount. Max 90%.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="stock">Stock</Label>
                <Input
                  id="stock"
                  type="number"
                  min="0"
                  required
                  value={form.stock}
                  onChange={update("stock")}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="description">Description</Label>
                <textarea
                  id="description"
                  required
                  rows={5}
                  value={form.description}
                  onChange={update("description")}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-soft transition placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                />
              </div>
            </div>
          </Card>
        </div>

        <Card className="h-fit space-y-3 p-6">
          <h3 className="text-lg font-semibold">Save changes</h3>
          <p className="text-sm text-muted-foreground">
            {images.length} image{images.length === 1 ? "" : "s"} attached.
          </p>
          <Button type="submit" size="lg" className="w-full" disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Save product
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            onClick={() => router.push("/admin/products")}
            disabled={submitting}
          >
            Cancel
          </Button>
        </Card>
      </form>
    </div>
  );
}
