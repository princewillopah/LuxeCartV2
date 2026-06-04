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

export interface Order {
  id: ID;
  userId: ID;
  status: "pending" | "paid" | "shipped" | "delivered" | "cancelled" | string;
  total: number;
  items: Array<{
    productId: ID;
    name: string;
    price: number;
    quantity: number;
  }>;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: User;
  message?: string;
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
