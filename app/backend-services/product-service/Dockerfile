# ─── Stage 1: build ─────────────────────────────────────────────────────
# Use a Maven image with JDK 21 so the produced bytecode matches the
# runtime stage. Layer the dependency download separately from the
# source copy so editing a .java file doesn't re-pull the dependency
# tree on every rebuild.
FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /app

# Resolve dependencies first — this layer is cached as long as pom.xml
# doesn't change.
COPY backend-services/product-service/pom.xml .
RUN mvn -B -q -e -DskipTests dependency:go-offline

# Now copy sources and build the fat jar.
COPY backend-services/product-service/src ./src
RUN mvn -B -q -e -DskipTests package

# ─── Stage 2: runtime ───────────────────────────────────────────────────
# JRE-only image to keep the runtime small. We don't ship Maven.
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app

# Drop privileges — Spring Boot doesn't need root inside the container.
RUN addgroup -S app && adduser -S app -G app
USER app

COPY --from=build --chown=app:app /app/target/product-service.jar /app/app.jar

# The Node service listened on 3003; we keep the same port so nothing
# upstream needs to change.
EXPOSE 3003

# Reasonable container defaults: prefer IPv4 (avoids slow DNS on some
# Linux hosts) and let Spring Boot pick a sensible heap based on the
# cgroup memory limit instead of hard-coding -Xmx.
ENV JAVA_OPTS="-Djava.net.preferIPv4Stack=true -XX:MaxRAMPercentage=75"

ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/app.jar"]
