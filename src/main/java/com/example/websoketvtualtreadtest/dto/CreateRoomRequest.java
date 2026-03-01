package com.example.websoketvtualtreadtest.dto;

public class CreateRoomRequest {
    private String creatorId;
    private String roomName;

    public String getCreatorId() { return creatorId; }
    public void setCreatorId(String creatorId) { this.creatorId = creatorId; }

    public String getRoomName() { return roomName; }
    public void setRoomName(String roomName) { this.roomName = roomName; }
}
