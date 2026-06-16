export type ID = string | number;

export interface User {
  id: ID;
  email: string;
  firstName: string;
  lastName: string;
  role: "user" | "admin";
}

export interface Product {
  id: ID;
  name: string;
  description: string;
  price: number;
  /**
   * Optional percentage discount (0–90). When > 0 the UI should render the
   * stroked original `price` next to the effective price. The actual sale
   * price is computed by `effectivePrice()` in lib/price.ts.
   */
  discountPercent?: number;
  category: string;
  stock: number;
  brand?: string | null;
  images?: string[] | null;
  averageRating?: number;
  totalReviews?: number;
  createdAt?: string;
}

export interface CartItem {
  productId: ID;
  name: string;
  price: number;
  image?: string;
  quantity: number;
}

export type OrderStatus =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "refunded";

export const ORDER_STATUSES: OrderStatus[] = [
  "pending",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
];

// Legal next states per actor role — must mirror order-service state machine.
export const ADMIN_NEXT_STATUSES: Record<OrderStatus, OrderStatus[]> = {
  pending:    ["processing", "shipped", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped:    ["delivered", "cancelled"],
  delivered:  ["refunded"],
  cancelled:  [],
  refunded:   [],
};

export interface OrderHistoryEntry {
  id: number;
  from_status: string | null;
  to_status: string;
  actor_role: string | null;
  note: string | null;
  created_at: string;
}

export interface OrderItem {
  id?: ID;
  productId: ID;
  productName?: string;
  name?: string;
  price: number;
  quantity: number;
}

export interface Order {
  id: ID;
  userId: ID;
  status: OrderStatus | string;
  total: number;
  items: OrderItem[];
  shippingAddress?: Record<string, unknown> | string | null;
  paymentMethod?: string | null;
  trackingNumber?: string | null;
  createdAt: string;
}

export interface DashboardStats {
  totalUsers: number;
  totalOrders: number;
  totalRevenue: number;
  totalProducts: number;
}

/** Saved shipping address tied to a user account. Used by the account
 * page (CRUD) and pre-filled into the checkout form. */
export interface Address {
  id: ID;
  fullName: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postal?: string | null;
  country: string;
  phone?: string | null;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Standard wire shape for paginated admin lists. */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface AuthResponse {
  token: string;
  /** Long-lived rotation token. Sent back to /api/auth/refresh when the
   * short-lived `token` (15-min access JWT) expires. */
  refreshToken?: string;
  /** Human-readable TTL string, e.g. "15m". Informational only. */
  expiresIn?: string;
  user: User;
  message?: string;
}

export interface RegisterResponse {
  user: User;
  message?: string;
  requiresVerification?: boolean;
}

export interface Review {
  id: ID;
  productId: ID;
  userId: ID;
  userName: string;
  rating?: number | null;
  comment: string;
  helpful?: number;
  verified?: boolean;
  createdAt: string;
}
