import { API_URL } from "@/lib/utils";
import type {
  AuthResponse,
  CartItem,
  Order,
  Product,
  Review,
  User,
} from "@/lib/types";

class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("luxecart-auth");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { token?: string } };
    return parsed?.state?.token ?? null;
  } catch {
    return null;
  }
}

interface RequestOpts extends Omit<RequestInit, "body"> {
  body?: unknown;
  auth?: boolean;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { body, auth, headers, ...rest } = opts;
  const h = new Headers(headers);
  if (body !== undefined) h.set("Content-Type", "application/json");
  if (auth) {
    const t = getToken();
    if (t) h.set("Authorization", `Bearer ${t}`);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) {
    const msg =
      (typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : null) ?? `Request failed: ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const api = {
  // ── auth ────────────────────────────────────────────────────────────────
  health: () => request<{ status: string }>(`/health`),

  login: (email: string, password: string) =>
    request<AuthResponse>(`/api/auth/login`, {
      method: "POST",
      body: { email, password },
    }),

  register: (input: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }) =>
    request<AuthResponse>(`/api/auth/register`, {
      method: "POST",
      body: input,
    }),

  me: () => request<User>(`/api/users/me`, { auth: true }),

  // ── products ────────────────────────────────────────────────────────────
  listProducts: (params?: { category?: string }) => {
    const q = params?.category && params.category !== "all"
      ? `?category=${encodeURIComponent(params.category)}`
      : "";
    return request<Product[]>(`/api/products/public${q}`);
  },

  getProduct: (id: string | number) =>
    request<Product>(`/api/products/public/${id}`),

  search: (q: string) =>
    request<Product[]>(`/api/search?q=${encodeURIComponent(q)}`),

  // ── cart ────────────────────────────────────────────────────────────────
  getCart: () => request<{ items: CartItem[] }>(`/api/cart`, { auth: true }),
  addToCart: (productId: string | number, quantity: number) =>
    request(`/api/cart`, {
      method: "POST",
      auth: true,
      body: { productId, quantity },
    }),

  // ── orders ──────────────────────────────────────────────────────────────
  listOrders: () => request<Order[]>(`/api/orders`, { auth: true }),
  createOrder: (input: {
    userId: string | number;
    total: number;
    items: Array<{
      id: string | number;
      name: string;
      price: number;
      quantity: number;
    }>;
    shippingAddress?: Record<string, unknown>;
    paymentMethod?: string;
  }) =>
    request<Order>(`/api/orders`, {
      method: "POST",
      auth: true,
      body: input,
    }),

  // ── reviews & ratings ───────────────────────────────────────────────────
  listReviews: (productId: string | number) =>
    request<Review[]>(`/api/reviews/public/product/${productId}`),

  createReview: (input: {
    productId: string | number;
    userId: string | number;
    userName?: string;
    comment: string;
  }) =>
    request<Review>(`/api/reviews`, {
      method: "POST",
      auth: true,
      body: input,
    }),

  submitRating: (input: {
    productId: string | number;
    userId: string | number;
    rating: number;
  }) =>
    request<{
      message: string;
      avgRating: number;
      totalRatings: number;
    }>(`/api/ratings/product/${input.productId}`, {
      method: "POST",
      auth: true,
      body: { userId: input.userId, rating: input.rating },
    }),

  // ── images ──────────────────────────────────────────────────────────────
  presignImage: (input: {
    contentType: string;
    ownerType: string;
    ownerId?: string | null;
    sizeBytes?: number;
  }) =>
    request<{
      id: string;
      key: string;
      uploadUrl: string;
      method: "PUT";
      headers: Record<string, string>;
      publicUrl: string;
      expiresIn: number;
    }>(`/api/images/presign`, {
      method: "POST",
      auth: true,
      body: input,
    }),

  confirmImage: (id: string) =>
    request<{
      id: string;
      key: string;
      url: string;
      sizeBytes: number;
      status: "ready";
    }>(`/api/images/confirm/${id}`, {
      method: "POST",
      auth: true,
    }),

  listImages: (ownerType: string, ownerId?: string) => {
    const q = new URLSearchParams({ ownerType });
    if (ownerId) q.set("ownerId", ownerId);
    return request<
      Array<{ id: string; key: string; url: string; content_type: string }>
    >(`/api/images/public?${q.toString()}`);
  },
};

export { ApiError };
