import { API_URL } from "@/lib/utils";
import type {
  Address,
  AuthResponse,
  CartItem,
  DashboardStats,
  Order,
  OrderHistoryEntry,
  OrderStatus,
  Paged,
  Product,
  RegisterResponse,
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

function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("luxecart-auth");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { refreshToken?: string } };
    return parsed?.state?.refreshToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist new tokens after a silent refresh. Mirrors the shape Zustand's
 * persist middleware writes, so the auth store picks the new values up on
 * its next read. We write directly here (instead of importing the store)
 * to avoid a circular dependency between api.ts and store/auth.ts.
 */
function persistRefreshedTokens(token: string, refreshToken: string | null) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem("luxecart-auth");
    const parsed = raw ? (JSON.parse(raw) as { state?: Record<string, unknown> }) : { state: {} };
    parsed.state = {
      ...parsed.state,
      token,
      ...(refreshToken !== null ? { refreshToken } : {}),
    };
    window.localStorage.setItem("luxecart-auth", JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
}

/**
 * Wipe local auth state when the refresh token is itself invalid (expired,
 * revoked, or detected as theft by the backend). The user must log in again.
 */
function clearAuthAndRedirect() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem("luxecart-auth");
    const parsed = raw ? (JSON.parse(raw) as { state?: Record<string, unknown> }) : { state: {} };
    parsed.state = { ...parsed.state, token: null, refreshToken: null, user: null };
    window.localStorage.setItem("luxecart-auth", JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
  // Notify the store to wipe per-user cache (cart, react-query, etc.).
  window.dispatchEvent(new CustomEvent("luxecart:auth-changed"));
}

/**
 * Silent token refresh. We only ever have ONE in-flight refresh promise;
 * concurrent 401s during the refresh window all await the same call so we
 * don't accidentally rotate the refresh token N times in parallel (which
 * would trip the backend's reuse-detection and revoke the family).
 */
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        cache: "no-store",
      });
      if (!res.ok) {
        // Refresh token itself is dead — force re-login.
        clearAuthAndRedirect();
        return null;
      }
      const data = (await res.json()) as { token: string; refreshToken?: string };
      persistRefreshedTokens(data.token, data.refreshToken ?? null);
      return data.token;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOpts extends Omit<RequestInit, "body"> {
  body?: unknown;
  auth?: boolean;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  return doRequest<T>(path, opts, /* allowRetry */ true);
}

/**
 * Inner request worker. Split out from `request` so the silent-refresh
 * retry can call it again with `allowRetry=false`, preventing infinite
 * loops if the refresh succeeds but the retried call still 401s.
 */
async function doRequest<T>(
  path: string,
  opts: RequestOpts,
  allowRetry: boolean,
): Promise<T> {
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

  // Silent refresh on access-token expiry. We only retry once, only for
  // authenticated calls, and only when we actually have a refresh token to
  // try. Any other 401 (bad credentials on /login, etc.) falls through to
  // the normal error path.
  if (
    res.status === 401 &&
    auth &&
    allowRetry &&
    typeof window !== "undefined" &&
    getRefreshToken()
  ) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      return doRequest<T>(path, opts, /* allowRetry */ false);
    }
  }

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
    request<RegisterResponse>(`/api/auth/register`, {
      method: "POST",
      body: input,
    }),

  // ── self-serve account actions ──────────────────────────────────────────
  verifyEmail: (token: string) =>
    request<{ message: string; userId: number }>(`/api/auth/verify-email`, {
      method: "POST",
      body: { token },
    }),

  resendVerification: (email: string) =>
    request<{ message: string }>(`/api/auth/resend-verification`, {
      method: "POST",
      body: { email },
    }),

  forgotPassword: (email: string) =>
    request<{ message: string }>(`/api/auth/forgot-password`, {
      method: "POST",
      body: { email },
    }),

  resetPassword: (token: string, password: string) =>
    request<{ message: string }>(`/api/auth/reset-password`, {
      method: "POST",
      body: { token, password },
    }),

  /**
   * Server-side logout — revokes the refresh token so it can't be used
   * again. Always resolves; the frontend should clear its local state
   * regardless of the network outcome.
   */
  logout: (refreshToken: string | null) =>
    request<{ message: string }>(`/api/auth/logout`, {
      method: "POST",
      body: { refreshToken },
    }).catch(() => ({ message: "Logged out (offline)" })),

  me: () => request<User>(`/api/users/me`, { auth: true }),

  // ── products ────────────────────────────────────────────────────────────
  listProducts: (params?: { category?: string }) => {
    const q = params?.category && params.category !== "all"
      ? `?category=${encodeURIComponent(params.category)}`
      : "";
    return request<Product[]>(`/api/products/public${q}`);
  },
  /** Paginated product list — used by the admin products page so the
   * table stays responsive once the catalog grows. */
  listProductsPaged: (params?: { page?: number; limit?: number; search?: string; category?: string }) => {
    const sp = new URLSearchParams();
    sp.set("page",  String(params?.page  ?? 1));
    sp.set("limit", String(params?.limit ?? 20));
    if (params?.search)   sp.set("search", params.search);
    if (params?.category && params.category !== "all") sp.set("category", params.category);
    return request<Paged<Product>>(`/api/products/public?${sp.toString()}`);
  },
  getProduct: (id: string | number) =>
    request<Product>(`/api/products/public/${id}`),

  /** Featured (top-rated) products for the storefront homepage. */
  listFeaturedProducts: (limit = 8) =>
    request<Product[]>(`/api/products/public/featured?limit=${limit}`),

  /** Category name + product count, derived from live data. */
  listCategoriesWithCount: () =>
    request<{ name: string; count: number }[]>(
      `/api/products/public/categories`,
    ),

  search: (q: string) =>
    request<Product[]>(`/api/search?q=${encodeURIComponent(q)}`),

  // ── cart (Phase 6: server-persisted) ────────────────────────────────────
  // Wire shape matches what cart-service returns:
  //   { userId: number, items: CartItem[] }
  // The store hydrates from `items` and ignores `userId`.
  getCart: () =>
    request<{ userId: number; items: CartItem[] }>(`/api/cart`, { auth: true }),
  addCartItem: (item: {
    productId: string | number;
    quantity: number;
    price: number;
    name: string;
    image?: string;
  }) =>
    request<{ userId: number; items: CartItem[] }>(`/api/cart/items`, {
      method: "POST",
      auth: true,
      body: item,
    }),
  setCartItemQty: (productId: string | number, quantity: number) =>
    request<{ userId: number; items: CartItem[] }>(
      `/api/cart/items/${productId}`,
      { method: "PUT", auth: true, body: { quantity } },
    ),
  removeCartItem: (productId: string | number) =>
    request<{ userId: number; items: CartItem[] }>(
      `/api/cart/items/${productId}`,
      { method: "DELETE", auth: true },
    ),
  clearCart: () =>
    request<{ userId: number; items: CartItem[] }>(`/api/cart`, {
      method: "DELETE",
      auth: true,
    }),
  /**
   * Merge a guest cart (built up while logged out and held in
   * localStorage by the zustand `persist` middleware) into the
   * authenticated user's server cart. Used right after login so the
   * customer doesn't lose what they were shopping for.
   */
  mergeGuestCart: (items: CartItem[]) =>
    request<{ userId: number; items: CartItem[] }>(`/api/cart/merge`, {
      method: "POST",
      auth: true,
      body: { items },
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
    // Snapshot the buyer's identity here so order-service can persist it on
    // the orders row at create time. Required under the database-per-service
    // split — orders_db can no longer JOIN against the users table
    // (which lives in auth_db).
    userEmail?: string;
    userFirstName?: string;
    userLastName?: string;
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

  // ── wishlist ────────────────────────────────────────────────────────────
  listWishlist: () =>
    request<Array<{ addedAt: string; product: Product }>>(
      `/api/users/wishlist`,
      { auth: true }
    ),
  listWishlistIds: () =>
    request<Array<string | number>>(`/api/users/wishlist/ids`, { auth: true }),
  addToWishlist: (productId: string | number) =>
    request<{ userId: number; productId: number }>(`/api/users/wishlist`, {
      method: "POST",
      auth: true,
      body: { productId },
    }),
  removeFromWishlist: (productId: string | number) =>
    request<void>(`/api/users/wishlist/${productId}`, {
      method: "DELETE",
      auth: true,
    }),

  // ── addresses ───────────────────────────────────────────────────────
  // Saved shipping addresses live in user-service and are scoped to the
  // caller (`x-user-id`) — no extra params required from the client.
  listMyAddresses: () =>
    request<Address[]>(`/api/users/addresses`, { auth: true }),

  createAddress: (input: Omit<Address, "id" | "createdAt" | "updatedAt">) =>
    request<Address>(`/api/users/addresses`, {
      method: "POST",
      auth: true,
      body: input,
    }),

  updateAddress: (id: string | number, input: Omit<Address, "id" | "createdAt" | "updatedAt">) =>
    request<Address>(`/api/users/addresses/${id}`, {
      method: "PUT",
      auth: true,
      body: input,
    }),

  deleteAddress: (id: string | number) =>
    request<void>(`/api/users/addresses/${id}`, {
      method: "DELETE",
      auth: true,
    }),

  setDefaultAddress: (id: string | number) =>
    request<{ id: number; isDefault: boolean }>(`/api/users/addresses/${id}/default`, {
      method: "POST",
      auth: true,
    }),

  submitRating: (input: {
    productId: string | number;
    userId: string | number;
    rating: number;
    userFirstName?: string;
    userLastName?: string;
  }) =>
    request<{
      message: string;
      avgRating: number;
      totalRatings: number;
    }>(`/api/ratings/product/${input.productId}`, {
      method: "POST",
      auth: true,
      body: {
        userId: input.userId,
        rating: input.rating,
        // Pass display name so rating-service can snapshot it. Under
        // the database-per-service split it can no longer JOIN against
        // users to read the rater's name at display time.
        userFirstName: input.userFirstName,
        userLastName: input.userLastName,
      },
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

  /**
   * Uploads an image through the api-gateway → image-service proxy route.
   * The browser never talks to S3/LocalStack directly, so this works
   * regardless of where the app is hosted (Azure VM, localhost, etc.).
   */
  uploadImage: async (
    file: File,
    ownerType: string,
    ownerId?: string,
  ): Promise<{ id: string; key: string; url: string; status: "ready" }> => {
    const fd = new FormData();
    fd.append("image", file);
    fd.append("ownerType", ownerType);
    if (ownerId) fd.append("ownerId", ownerId);
    const h = new Headers();
    const t = getToken();
    if (t) h.set("Authorization", `Bearer ${t}`);
    const res = await fetch(`${API_URL}/api/images/upload`, {
      method: "POST",
      headers: h,
      body: fd,
    });
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json")
      ? await res.json()
      : await res.text();
    if (!res.ok) {
      const msg =
        (typeof data === "object" && data && "error" in data
          ? String((data as { error: unknown }).error)
          : null) ?? `Upload failed: ${res.status}`;
      throw new ApiError(msg, res.status, data);
    }
    return data as { id: string; key: string; url: string; status: "ready" };
  },

  listImages: (ownerType: string, ownerId?: string) => {
    const q = new URLSearchParams({ ownerType });
    if (ownerId) q.set("ownerId", ownerId);
    return request<
      Array<{ id: string; key: string; url: string; content_type: string }>
    >(`/api/images/public?${q.toString()}`);
  },

  // ── admin: dashboard / analytics ────────────────────────────────────────
  adminDashboardStats: () =>
    request<DashboardStats>(`/api/admin/dashboard/stats`, { auth: true }),

  adminRevenueAnalytics: () =>
    request<Array<{ date: string; revenue: string; orders: string }>>(
      `/api/admin/analytics/revenue`,
      { auth: true }
    ),

  adminTopProducts: () =>
    request<
      Array<{
        id: number;
        name: string;
        price: string;
        order_count: string;
        total_sold: string | null;
      }>
    >(`/api/admin/analytics/top-products`, { auth: true }),

  // ── admin: products ─────────────────────────────────────────────────────
  createProduct: (input: Partial<Product> & { name: string; price: number }) =>
    request<Product>(`/api/products`, {
      method: "POST",
      auth: true,
      body: input,
    }),

  updateProduct: (id: string | number, input: Partial<Product>) =>
    request<Product>(`/api/products/${id}`, {
      method: "PUT",
      auth: true,
      body: input,
    }),

  deleteProduct: (id: string | number) =>
    request<{ message?: string }>(`/api/products/${id}`, {
      method: "DELETE",
      auth: true,
    }),

  // ── admin: orders ───────────────────────────────────────────────────────
  /** Paginated admin order list. Returns `{ items, total, page, limit }`
   * when params supplied, so the table can render a pager. */
  adminListOrders: (params?: { page?: number; limit?: number; status?: string }) => {
    const sp = new URLSearchParams();
    sp.set("page",  String(params?.page  ?? 1));
    sp.set("limit", String(params?.limit ?? 20));
    if (params?.status && params.status !== "all") sp.set("status", params.status);
    return request<Paged<Order>>(`/api/orders/admin/all?${sp.toString()}`, { auth: true });
  },

  updateOrderStatus: (id: string | number, status: OrderStatus, note?: string) =>
    request<Order>(`/api/orders/${id}/status`, {
      method: "PATCH",
      auth: true,
      body: note ? { status, note } : { status },
    }),

  // Customer self-cancel (also usable by admin). Order-service enforces
  // role-specific transition rules — customer can only cancel while the
  // order is still pending or processing.
  cancelOrder: (id: string | number, note?: string) =>
    request<Order>(`/api/orders/${id}/cancel`, {
      method: "POST",
      auth: true,
      body: note ? { note } : {},
    }),

  orderHistory: (id: string | number) =>
    request<{ orderId: number; history: OrderHistoryEntry[] }>(
      `/api/orders/${id}/history`,
      { auth: true }
    ),

  // ── admin: users ─────────────────────────────────────────────────────
  adminListUsers: (params?: { page?: number; limit?: number; search?: string }) => {
    const sp = new URLSearchParams();
    sp.set("page",  String(params?.page  ?? 1));
    sp.set("limit", String(params?.limit ?? 20));
    if (params?.search) sp.set("search", params.search);
    return request<Paged<User>>(`/api/users?${sp.toString()}`, { auth: true });
  },

  adminDeleteUser: (id: string | number) =>
    request<{ message?: string }>(`/api/users/${id}`, {
      method: "DELETE",
      auth: true,
    }),

  // ── payments ────────────────────────────────────────────────────────────
  /**
   * List the payment gateways the backend currently has configured.
   * The checkout dropdown only shows what comes back from here, so adding
   * a gateway means setting its keys — no frontend redeploy.
   */
  getPaymentProviders: () =>
    request<{ providers: { name: string; displayName: string }[] }>(
      `/api/payments/providers`,
      { auth: true }
    ),

  /**
   * Open a transaction with the chosen gateway. Returns the URL the browser
   * should be redirected to so the customer can complete payment.
   */
  initializePayment: (input: {
    orderId: string | number;
    amount: number;
    email: string;
    provider?: string; // "paystack" | "flutterwave"; backend defaults to paystack
  }) =>
    request<{
      paymentId: number;
      provider: string;
      reference: string;
      authorizationUrl: string;
      accessCode?: string;
    }>(`/api/payments/initialize`, {
      method: "POST",
      auth: true,
      body: input,
    }),

  /**
   * Re-check a payment with its gateway after the customer returns to the
   * callback page. Idempotent — calling twice with the same reference is
   * safe.
   */
  verifyPayment: (reference: string) =>
    request<{
      reference: string;
      provider: string;
      status: "success" | "failed" | "abandoned" | "pending";
      amount: number;
      currency: string;
      orderId: number;
      paymentId: number;
      alreadySettled: boolean;
    }>(`/api/payments/verify/${encodeURIComponent(reference)}`, {
      auth: true,
    }),
};

export { ApiError };
