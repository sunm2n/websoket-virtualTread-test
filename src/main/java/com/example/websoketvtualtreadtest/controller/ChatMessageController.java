package com.example.websoketvtualtreadtest.controller;

import com.example.websoketvtualtreadtest.dto.JoinRoomPayload;
import com.example.websoketvtualtreadtest.dto.RoomResponse;
import com.example.websoketvtualtreadtest.model.ChatMessage;
import com.example.websoketvtualtreadtest.model.ChatRoom;
import com.example.websoketvtualtreadtest.model.MessageType;
import com.example.websoketvtualtreadtest.store.ChatRoomStore;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;

import java.util.List;
import java.util.Map;
import java.util.Objects;

@Controller
public class ChatMessageController {

    private final ChatRoomStore store;
    private final SimpMessagingTemplate messaging;

    public ChatMessageController(ChatRoomStore store, SimpMessagingTemplate messaging) {
        this.store = store;
        this.messaging = messaging;
    }

    @MessageMapping("/room.join")
    public void joinRoom(@Payload JoinRoomPayload payload, SimpMessageHeaderAccessor headerAccessor) {
        String roomId = payload.getRoomId();
        String userId = payload.getUserId();

        boolean joined = store.joinRoom(roomId, userId);
        if (!joined) {
            messaging.convertAndSendToUser(
                    headerAccessor.getSessionId(),
                    "/queue/errors",
                    new ChatMessage(MessageType.ERROR, roomId, "system", "Room is full"),
                    Map.of("simpSessionId", Objects.requireNonNull(headerAccessor.getSessionId()))
            );
            return;
        }

        // Save session attributes for disconnect cleanup
        Map<String, Object> sessionAttrs = Objects.requireNonNull(headerAccessor.getSessionAttributes());
        sessionAttrs.put("userId", userId);
        sessionAttrs.put("roomId", roomId);

        messaging.convertAndSend("/topic/room/" + roomId,
                new ChatMessage(MessageType.JOIN, roomId, userId, userId + " has joined"));

        broadcastRoomList();
    }

    @MessageMapping("/room.leave")
    public void leaveRoom(@Payload JoinRoomPayload payload) {
        performLeave(payload.getRoomId(), payload.getUserId());
    }

    @MessageMapping("/room.send")
    public void sendMessage(@Payload ChatMessage message) {
        ChatRoom room = store.getRoom(message.getRoomId());
        if (room == null) return;
        message.setType(MessageType.CHAT);
        messaging.convertAndSend("/topic/room/" + message.getRoomId(), message);
    }

    public void performLeave(String roomId, String userId) {
        ChatRoom room = store.getRoom(roomId);
        if (room == null) return;

        if (room.getCreatorId().equals(userId)) {
            // Creator leaves → delete the room
            store.deleteRoom(roomId);
            messaging.convertAndSend("/topic/room/" + roomId,
                    new ChatMessage(MessageType.ROOM_DELETED, roomId, userId, "Room has been deleted by creator"));
        } else {
            store.leaveRoom(roomId, userId);
            messaging.convertAndSend("/topic/room/" + roomId,
                    new ChatMessage(MessageType.LEAVE, roomId, userId, userId + " has left"));
        }

        broadcastRoomList();
    }

    private void broadcastRoomList() {
        List<RoomResponse> rooms = store.getAllRooms().stream()
                .map(RoomResponse::from)
                .toList();
        messaging.convertAndSend("/topic/rooms", rooms);
    }
}
