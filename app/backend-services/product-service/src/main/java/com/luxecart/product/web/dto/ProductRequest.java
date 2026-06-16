package com.luxecart.product.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;

import java.math.BigDecimal;

/**
 * Inbound payload for create + update. Validation annotations mirror
 * the implicit rules the Node service enforced through ad-hoc checks
 * + database constraints.
 *
 * `discountPercent` is intentionally an {@link Integer} (boxed) so it
 * can be `null` — when null we treat it as 0, matching the legacy
 * `clampDiscount()` behaviour.
 */
public record ProductRequest(
        @NotBlank String     name,
                  String     description,
        @NotNull  @Positive  BigDecimal price,
        @NotBlank String     category,
        @PositiveOrZero Integer    stock,
                          String     brand,
                          String[]   images,
                          Integer    discountPercent
) {}
