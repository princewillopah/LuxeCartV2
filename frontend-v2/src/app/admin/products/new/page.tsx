"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/empty-state";
import {
  ImageUploader,
  type UploadedImage,
} from "@/components/image-uploader";
import { API_URL } from "@/lib/utils";
import { useAuth } from "@/store/auth";

export default function NewProductPage() {
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const token = useAuth((s) => s.token);

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const [images, setImages] = React.useState<UploadedImage[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [form, setForm] = React.useState({
    name: "",
    brand: "",
    price: "",
    stock: "",
    category: "Electronics",
    description: "",
  });

  if (!mounted) return <div className="container py-16" />;

  if (!user) {
    return (
      <div className="container py-16">
        <EmptyState
          title="Sign in required"
          description="Sign in as an admin to create products."
          actionLabel="Sign in"
          actionHref="/auth/login?next=/admin/products/new"
        />
      </div>
    );
  }

  if (user.role !== "admin") {
    return (
      <div className="container py-16">
        <EmptyState
          title="Admin only"
          description="This page is restricted to admin accounts."
          actionLabel="Back home"
          actionHref="/"
        />
      </div>
    );
  }

  function update(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/products`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: form.name,
          brand: form.brand,
          price: Number(form.price),
          stock: Number(form.stock),
          category: form.category,
          description: form.description,
          images: images.map((i) => i.url),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      toast.success("Product created");
      router.push("/products");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container py-10">
      <div className="mb-8 flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-glow">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            New product
          </h1>
          <p className="text-sm text-muted-foreground">
            Images are uploaded directly to S3 via presigned URLs.
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="mb-4 text-lg font-semibold">Images</h2>
            <ImageUploader
              ownerType="product"
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
              <div className="space-y-1.5">
                <Label htmlFor="category">Category</Label>
                <Input id="category" value={form.category} onChange={update("category")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="price">Price (USD)</Label>
                <Input id="price" type="number" min="0" step="0.01" required value={form.price} onChange={update("price")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="stock">Stock</Label>
                <Input id="stock" type="number" min="0" required value={form.stock} onChange={update("stock")} />
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

        <Card className="h-fit p-6">
          <h3 className="text-lg font-semibold">Publish</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Review the details on the left, then publish.
          </p>
          <Button type="submit" size="lg" className="mt-6 w-full" disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Publish product
          </Button>
          <p className="mt-3 text-center text-xs text-muted-foreground">
            {images.length} image{images.length === 1 ? "" : "s"} attached
          </p>
        </Card>
      </form>
    </div>
  );
}
