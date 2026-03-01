package com.example.websoketvtualtreadtest.model;

import java.time.Instant;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public class ChatRoom {

    private static final int MAX_PARTICIPANTS = 2;

    private final String roomId;
    private final String roomName;
    private final String creatorId;
    private final Set<String> participants;
    private final Instant createdAt;

    public ChatRoom(String roomId, String roomName, String creatorId) {
        this.roomId = roomId;
        this.roomName = roomName;
        this.creatorId = creatorId;
        this.participants = ConcurrentHashMap.newKeySet();
        this.createdAt = Instant.now();
    }

    public boolean isFull() {
        return participants.size() >= MAX_PARTICIPANTS;
    }

    public boolean addParticipant(String userId) {
        if (isFull()) return false;
        participants.add(userId);
        return true;
    }

    public void removeParticipant(String userId) {
        participants.remove(userId);
    }

    public String getRoomId() { return roomId; }
    public String getRoomName() { return roomName; }
    public String getCreatorId() { return creatorId; }
    public Set<String> getParticipants() { return participants; }
    public Instant getCreatedAt() { return createdAt; }
}
