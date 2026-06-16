package com.luxecart.product.config;

import org.springframework.boot.autoconfigure.cache.RedisCacheManagerBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.cache.RedisCacheConfiguration;
import org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.StringRedisSerializer;

import java.time.Duration;

/**
 * Mirrors the Node service's 5-minute TTL on every cached endpoint.
 * One default config covers every cache name (productsList,
 * productsFeatured, productsCategories, productSingle).
 *
 * Keys are stored as Strings (so we can inspect them with `redis-cli
 * KEYS`), values as JSON via the default GenericJackson serializer
 * (which is type-aware — list/object/dto round-trip without help).
 *
 * Note: ProductDto exposes `createdAt` as a String, not Instant —
 * see ProductDto's class javadoc for why.
 */
@Configuration
public class RedisCacheConfig {

    @Bean
    RedisCacheManagerBuilderCustomizer cacheCustomizer() {
        GenericJackson2JsonRedisSerializer jsonSerializer =
                new GenericJackson2JsonRedisSerializer();

        RedisCacheConfiguration cfg = RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(5))
                .disableCachingNullValues()
                .serializeKeysWith(RedisSerializationContext.SerializationPair.fromSerializer(
                        new StringRedisSerializer()))
                .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(
                        jsonSerializer));

        return (builder) -> builder
                .cacheDefaults(cfg)
                .withCacheConfiguration("productsList",       cfg)
                .withCacheConfiguration("productsFeatured",   cfg)
                .withCacheConfiguration("productsCategories", cfg)
                .withCacheConfiguration("productSingle",      cfg);
    }
}
