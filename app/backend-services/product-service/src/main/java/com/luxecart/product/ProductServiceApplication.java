package com.luxecart.product;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;

/**
 * Entry point for the product-service Spring Boot replacement of the
 * legacy Node.js service. Routes, ports, and JSON shapes are kept
 * intentionally identical so every upstream caller (api-gateway,
 * frontend-v2, inventory-service) continues to work unmodified.
 */
@SpringBootApplication
@EnableCaching
public class ProductServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(ProductServiceApplication.class, args);
    }
}
