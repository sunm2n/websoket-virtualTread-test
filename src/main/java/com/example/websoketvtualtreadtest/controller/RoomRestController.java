package com.example.websoketvtualtreadtest.controller;

import com.example.websoketvtualtreadtest.dto.CreateRoomRequest;
import com.example.websoketvtualtreadtest.dto.RoomResponse;
import com.example.websoketvtualtreadtest.model.ChatMessage;
import com.example.websoketvtualtreadtest.model.ChatRoom;
import com.example.websoketvtualtreadtest.model.MessageType;
import com.example.websoketvtualtreadtest.store.ChatRoomStore;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/rooms")
public class RoomRestController {

    private final ChatRoomStore store;
    private final SimpMessagingTemplate messaging;

    public RoomRestController(ChatRoomStore store, SimpMessagingTemplate messaging) {
        this.store = store;
        this.messaging = messaging;
    }

    @GetMapping
    public List<RoomResponse> listRooms() {
        return store.getAllRooms().stream()
                .map(RoomResponse::from)
                .toList();
    }

    @PostMapping
    public ResponseEntity<RoomResponse> createRoom(@RequestBody CreateRoomRequest req) {
        String roomId = UUID.randomUUID().toString();
        ChatRoom room = new ChatRoom(roomId, req.getRoomName(), req.getCreatorId());
        store.addRoom(room);

        broadcastRoomList();

        return ResponseEntity.status(HttpStatus.CREATED).body(RoomResponse.from(room));
    }

    @DeleteMapping("/{roomId}")
    public ResponseEntity<Void> deleteRoom(
            @PathVariable String roomId,
            @RequestParam String userId) {

        ChatRoom room = store.getRoom(roomId);
        if (room == null) {
            return ResponseEntity.notFound().build();
        }
        if (!room.getCreatorId().equals(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }

        store.deleteRoom(roomId);

        // Notify room participants
        messaging.convertAndSend("/topic/room/" + roomId,
                new ChatMessage(MessageType.ROOM_DELETED, roomId, userId, "Room has been deleted"));

        broadcastRoomList();

        return ResponseEntity.noContent().build();
    }

    private void broadcastRoomList() {
        List<RoomResponse> rooms = store.getAllRooms().stream()
                .map(RoomResponse::from)
                .toList();
        messaging.convertAndSend("/topic/rooms", rooms);
    }
}
