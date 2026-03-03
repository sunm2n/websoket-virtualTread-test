package com.example.websoketvtualtreadtest.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.VirtualThreadTaskExecutor;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    @Value("${spring.threads.virtual.enabled:false}")
    private boolean virtualThreadEnabled;

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic", "/queue");
        registry.setApplicationDestinationPrefixes("/app");
        registry.setUserDestinationPrefix("/user");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws").withSockJS();
    }

    // 클라이언트 → 서버 방향 (@MessageMapping 핸들러 실행 스레드)
    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        if (virtualThreadEnabled) {
            registration.executor(new VirtualThreadTaskExecutor("stomp-inbound-"));
        }
    }

    // 서버 → 클라이언트 방향 (구독자에게 메시지 전달 스레드)
    @Override
    public void configureClientOutboundChannel(ChannelRegistration registration) {
        if (virtualThreadEnabled) {
            registration.executor(new VirtualThreadTaskExecutor("stomp-outbound-"));
        }
    }
}
