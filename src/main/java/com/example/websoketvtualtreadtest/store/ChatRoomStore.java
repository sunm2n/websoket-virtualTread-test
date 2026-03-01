package com.example.websoketvtualtreadtest.store;

import com.example.websoketvtualtreadtest.model.ChatRoom;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class ChatRoomStore {

    private final ConcurrentHashMap<String, ChatRoom> rooms = new ConcurrentHashMap<>();

    public Collection<ChatRoom> getAllRooms() {
        return rooms.values();
    }

    public ChatRoom getRoom(String roomId) {
        return rooms.get(roomId);
    }

    public void addRoom(ChatRoom room) {
        rooms.put(room.getRoomId(), room);
    }

    public ChatRoom deleteRoom(String roomId) {
        return rooms.remove(roomId);
    }

    /**
     * Thread-safe check-then-act: only adds the participant if the room is not full.
     * Returns true on success, false if the room is full or not found.
     */
    public synchronized boolean joinRoom(String roomId, String userId) {
        ChatRoom room = rooms.get(roomId);
        if (room == null) return false;
        return room.addParticipant(userId);
    }

    public void leaveRoom(String roomId, String userId) {
        ChatRoom room = rooms.get(roomId);
        if (room != null) {
            room.removeParticipant(userId);
        }
    }
}
