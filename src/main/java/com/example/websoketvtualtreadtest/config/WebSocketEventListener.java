package com.example.websoketvtualtreadtest.config;

import com.example.websoketvtualtreadtest.controller.ChatMessageController;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.util.Map;

@Component
public class WebSocketEventListener {

    private final ChatMessageController chatMessageController;

    public WebSocketEventListener(ChatMessageController chatMessageController) {
        this.chatMessageController = chatMessageController;
    }

    @EventListener
    public void handleWebSocketDisconnectListener(SessionDisconnectEvent event) {
        StompHeaderAccessor headerAccessor = StompHeaderAccessor.wrap(event.getMessage());
        Map<String, Object> sessionAttrs = headerAccessor.getSessionAttributes();
        if (sessionAttrs == null) return;

        String userId = (String) sessionAttrs.get("userId");
        String roomId = (String) sessionAttrs.get("roomId");

        if (userId != null && roomId != null) {
            chatMessageController.performLeave(roomId, userId);
        }
    }
}
