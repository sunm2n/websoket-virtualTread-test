package com.example.websoketvtualtreadtest.dto;

import com.example.websoketvtualtreadtest.model.ChatRoom;

import java.time.Instant;

public class RoomResponse {
    private String roomId;
    private String roomName;
    private String creatorId;
    private int participantCount;
    private boolean full;
    private Instant createdAt;

    public static RoomResponse from(ChatRoom room) {
        RoomResponse r = new RoomResponse();
        r.roomId = room.getRoomId();
        r.roomName = room.getRoomName();
        r.creatorId = room.getCreatorId();
        r.participantCount = room.getParticipants().size();
        r.full = room.isFull();
        r.createdAt = room.getCreatedAt();
        return r;
    }

    public String getRoomId() { return roomId; }
    public String getRoomName() { return roomName; }
    public String getCreatorId() { return creatorId; }
    public int getParticipantCount() { return participantCount; }
    public boolean isFull() { return full; }
    public Instant getCreatedAt() { return createdAt; }
}
